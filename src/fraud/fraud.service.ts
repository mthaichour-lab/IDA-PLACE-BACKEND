import { InjectRepository } from '@mikro-orm/nestjs';
import { FilterQuery, RequestContext } from '@mikro-orm/core';
import { EntityRepository } from '@mikro-orm/postgresql';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { assertCompanyAccess, resolveTenantFilter } from '../common/rbac/tenant-scope';
import { ClaimsService } from '../claims/claims.service';
import { DEFAULT_ELIGIBILITY_CONFIG } from '../eligibility/eligibility.rules';
import { MatchingService } from '../matching/matching.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import { FraudActionViewDto, FraudCaseViewDto, FraudSignalGroupDto } from './dto/fraud.dto';
import { FraudAction, FraudActionType } from './entities/fraud-action.entity';
import { FraudCase } from './entities/fraud-case.entity';
import {
  detectAbInconsistencies,
  detectCalibratedAmounts,
  detectDuplicates,
  detectEconstatReuse,
  detectVehicleRecurrence,
  detectVelocity,
  FraudCaseCandidate,
  FraudClaimInput,
  MatchedPairAmounts,
} from './fraud.detection';
import { projectFraudCase } from './fraud.projection';

type MemoryFraudCase = FraudCaseViewDto & { dedupeKey: string };

/** SEC-36 — couverture de la dernière analyse anti-fraude. */
export interface FraudAnalysisStatus {
  claimsAnalyzed: number;
  /** Vrai si `ANALYSIS_MAX_CLAIMS` a été atteint : les dossiers les plus anciens n'ont pas été analysés. */
  truncated: boolean;
  computedAt?: string;
}

/** Regroupement d'affichage (écran 9, panneau de détail) — noms des groupes tels que cités par le dossier technique §9. */
const FRAUD_CASE_TYPE_TO_GROUP = {
  DOUBLON: 'DOUBLONS_ECONSTAT',
  ECONSTAT_REUTILISE: 'DOUBLONS_ECONSTAT',
  RECURRENCE_VEHICULE: 'RESEAU_RECURRENCE',
  MONTANT_CALIBRE: 'MONTANTS_PLAFOND',
  INCOHERENCE_AB: 'INCOHERENCES_AB',
  VELOCITE_ADHERENT: 'VELOCITE',
} as const;

/** Décision humaine (MatchingService.decide, via match.updated) → type d'action du journal (B.9). Mapping assumé, à valider avec le métier. */
function mapStatusToActionType(status: string): FraudActionType | undefined {
  switch (status) {
    case 'CONFIRME_MANUEL':
      return 'APPARIEMENT_MANUEL';
    case 'REJETE':
      return 'DELIAGE';
    case 'COMPLEMENT':
      return 'RELIAGE';
    default:
      return undefined; // AUTO_CONFIRME / A_CONFIRMER : pas une décision humaine, pas de journal.
  }
}

/**
 * FraudModule — écran 9 "Anti-fraude", B.2/B.9.
 *
 * Détection RÉELLE des 5 règles de `fraud.detection.ts`, à partir des
 * données réelles de `ClaimsModule`/`MatchingModule` (jamais inventées).
 * Persistance idempotente (`dedupeKey`), repli mémoire si la base est
 * injoignable (mode dégradé, voir README.md).
 *
 * Journal des actions suspectes (B.9) :
 *  - appariement manuel / déliage / reliage : observés en RÉEL via
 *    `RealtimeGateway.onEvent('match.updated', ...)` — `MatchingService.
 *    decide()` émet cet événement à chaque décision humaine (voir
 *    matching.service.ts) ; FraudModule ne réimplémente aucune logique de
 *    matching, il écoute seulement le service public (ARCHITECTURE.md).
 *  - transmission tardive : détectée au recalcul périodique à partir du
 *    délai réel accident → ingestion (`Claim.createdAt`), idempotent par
 *    `claimId`.
 *
 * // TODO sprint suivant : une fois CommissionModule réel, enrichir le score
 * // de gravité avec les pénalités effectivement prononcées ; une fois
 * // RecoursModule réel, croiser avec les forclusions/silences de place.
 */
@Injectable()
export class FraudService implements OnApplicationBootstrap {
  private readonly logger = new Logger('FraudService');
  private readonly memoryCases: MemoryFraudCase[] = [];
  private readonly memoryActions: FraudActionViewDto[] = [];
  private readonly ceiling: number;
  private readonly recurrenceWindowDays: number;
  private readonly transmissionLateDays: number;
  private readonly velocitySameDayThreshold: number;
  private running?: Promise<void>;
  private rerunRequested = false;
  private lastAnalysis: FraudAnalysisStatus = { claimsAnalyzed: 0, truncated: false };

  constructor(
    @InjectRepository(FraudCase) private readonly caseRepo: EntityRepository<FraudCase>,
    @InjectRepository(FraudAction) private readonly actionRepo: EntityRepository<FraudAction>,
    private readonly claims: ClaimsService,
    private readonly matching: MatchingService,
    private readonly realtime: RealtimeGateway,
    configService: ConfigService,
  ) {
    this.ceiling = Number(configService.get<string>('ELIGIBILITY_MAX_AMOUNT_DA') ?? DEFAULT_ELIGIBILITY_CONFIG.maxAmountDA);
    this.recurrenceWindowDays = Number(configService.get<string>('FRAUD_RECURRENCE_WINDOW_DAYS') ?? 90);
    this.transmissionLateDays = Number(configService.get<string>('FRAUD_TRANSMISSION_LATE_DAYS') ?? 15);
    this.velocitySameDayThreshold = Number(configService.get<string>('FRAUD_VELOCITY_SAME_DAY_THRESHOLD') ?? 3);

    // B.9 — journal des actions suspectes : observe réellement les décisions
    // humaines de MatchingModule (jamais un import direct du module, voir
    // doc de classe).
    this.realtime.onEvent('match.updated', (payload) => this.handleMatchUpdated(payload));
    // SEC-13 : le recalcul (avec écritures) n'est plus déclenché par les GET
    // mais à l'ingestion de nouveaux dossiers, sous verrou en mémoire.
    this.realtime.onEvent('claim.ingested', () => void this.scheduleRecompute('import'));
  }

  onApplicationBootstrap(): void {
    void this.scheduleRecompute('démarrage');
  }

  /**
   * SEC-13 — un seul recalcul à la fois (verrou en mémoire du process) ; un
   * déclenchement pendant un calcul en cours le fait rejouer UNE fois à la
   * fin (données arrivées entre-temps), jamais en parallèle. `@nestjs/schedule`
   * n'étant pas installé, pas de tâche périodique : ingestion + démarrage.
   */
  scheduleRecompute(reason: string): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        // Appelé hors requête HTTP (bootstrap, écoute d'événement realtime) :
        // aucun RequestContext MikroORM n'est établi par Nest ici (il ne
        // l'est qu'autour d'une requête entrante) — à défaut, les repos
        // @InjectRepository utilisent l'EntityManager global et échouent
        // (« Using global EntityManager instance methods … »). Même motif
        // que RecoursService.computeAllViews.
        await RequestContext.create(this.caseRepo.getEntityManager(), async () => {
          do {
            this.rerunRequested = false;
            await this.recompute();
          } while (this.rerunRequested);
        });
      } catch (err) {
        this.logger.error(`Recalcul anti-fraude (${reason}) en échec : ${(err as Error).message}`);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** Lecture cohérente : attend un recalcul DÉJÀ en cours, sans jamais en déclencher (aucun GET n'écrit). */
  private async whenIdle(): Promise<void> {
    if (this.running) await this.running;
  }

  /** SEC-36 : état de la dernière analyse (troncature signalée, jamais masquée). */
  analysisStatus(): FraudAnalysisStatus {
    return { ...this.lastAnalysis };
  }

  private handleMatchUpdated(payload: unknown): void {
    const p = payload as { decision?: { id: string; status: string; decidedAt: string; decidedBy: string } } | undefined;
    if (!p?.decision) return; // recalcul automatique (ingestClaim) — pas une décision humaine, pas de journal.
    const actionType = mapStatusToActionType(p.decision.status);
    if (!actionType) return;
    this.logAction(actionType, p.decision.decidedBy, { matchId: p.decision.id, status: p.decision.status }).catch((err) =>
      this.logger.error(`Échec journalisation action suspecte (${actionType}): ${(err as Error).message}`),
    );
  }

  private toActionView(e: FraudAction): FraudActionViewDto {
    return { id: e.id, type: e.type, actor: e.actor, claimId: e.claimId, matchId: e.matchId, details: e.details, at: e.at.toISOString() };
  }

  private async logAction(type: FraudActionType, actor: string, details?: Record<string, unknown>, claimId?: string): Promise<void> {
    await withDegradedFallback(
      'FraudService.logAction',
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entity = this.actionRepo.create({ type, actor, claimId, details } as any);
        await this.actionRepo.getEntityManager().persistAndFlush(entity);
      },
      () => {
        this.memoryActions.push({ id: randomUUID(), type, actor, claimId, details, at: new Date().toISOString() });
      },
    );
  }

  /** Idempotent par `claimId` + `type` (évite de rejournaliser à chaque recalcul périodique). */
  private async logActionIfAbsent(type: FraudActionType, actor: string, claimId: string, details: Record<string, unknown>): Promise<void> {
    const exists = await withDegradedFallback(
      'FraudService.logActionIfAbsent',
      async () => !!(await this.actionRepo.findOne({ type, claimId })),
      () => this.memoryActions.some((a) => a.type === type && a.claimId === claimId),
    );
    if (exists) return;
    await this.logAction(type, actor, details, claimId);
  }

  /** SEC-13 : pagination EN BASE (plus de fenêtre de 5 000 entrées chargée à chaque appel). */
  async actions(page: number, pageSize: number): Promise<PaginatedResult<FraudActionViewDto>> {
    const safePage = Math.max(1, page);
    return withDegradedFallback(
      'FraudService.actions',
      async () => {
        const [rows, total] = await this.actionRepo.findAndCount({}, { orderBy: { at: 'DESC', id: 'ASC' }, limit: pageSize, offset: (safePage - 1) * pageSize });
        return new PaginatedResult(rows.map((e) => this.toActionView(e)), total, safePage);
      },
      () => paginateArray([...this.memoryActions].sort((a, b) => (a.at < b.at ? 1 : -1)), safePage, pageSize),
    );
  }

  /** Revue sécurité 2026-10-18 (B.7) : filtre par `companiesInvolved` quand l'appelant est scopé compagnie — un cas reste visible à une compagnie partie même s'il en nomme une autre (détection inter-compagnies par nature). SEC-13 : filtre et pagination EN BASE, sans recalcul. */
  async cases(page: number, pageSize: number, user?: AuthenticatedUser): Promise<PaginatedResult<FraudCaseViewDto> & { analysis: FraudAnalysisStatus }> {
    await this.whenIdle();
    const tenant = user ? resolveTenantFilter(user) : undefined;
    const { rows, total } = await this.readCases(tenant, { page, pageSize });
    const result = new PaginatedResult(await this.project(rows, tenant), total, Math.max(1, page));
    return Object.assign(result, { analysis: this.analysisStatus() });
  }

  private toCaseView(e: FraudCase): FraudCaseViewDto {
    return {
      id: e.id,
      type: e.type,
      score: e.score,
      severity: e.severity,
      claimIds: e.claimIds,
      companiesInvolved: e.companiesInvolved,
      details: e.details,
      detectedAt: (e.updatedAt ?? e.detectedAt).toISOString(),
    };
  }

  /**
   * SEC-13 — cas filtrés par compagnie partie (`companies_involved @> {X}`)
   * puis triés/paginés EN BASE ; plus de `limit 5000` appliqué avant le
   * filtre tenant. Sans `paging` : tous les cas de la compagnie (signaux).
   */
  private async readCases(company: string | undefined, paging?: { page: number; pageSize: number }): Promise<{ rows: FraudCaseViewDto[]; total: number }> {
    return withDegradedFallback(
      'FraudService.cases',
      async () => {
        const where: FilterQuery<FraudCase> = company ? { companiesInvolved: { $contains: [company] } } : {};
        const orderBy = { score: 'DESC', id: 'ASC' } as const;
        if (!paging) {
          const all = await this.caseRepo.find(where, { orderBy });
          return { rows: all.map((e) => this.toCaseView(e)), total: all.length };
        }
        const [ents, total] = await this.caseRepo.findAndCount(where, { orderBy, limit: paging.pageSize, offset: (Math.max(1, paging.page) - 1) * paging.pageSize });
        return { rows: ents.map((e) => this.toCaseView(e)), total };
      },
      () => {
        const all = this.memoryCases
          .map(({ dedupeKey: _dedupeKey, ...rest }) => rest)
          .filter((c) => !company || c.companiesInvolved.includes(company))
          .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
        if (!paging) return { rows: all, total: all.length };
        const p = paginateArray(all, paging.page, paging.pageSize);
        return { rows: p.items, total: p.total };
      },
    );
  }

  /**
   * `plateA` (jointure réelle sur le premier dossier lié — jamais fabriquée),
   * en ne lisant que les dossiers des cas renvoyés ; SEC-26 : projection par
   * tenant (ses dossiers + nombre de contreparties) pour un rôle compagnie.
   */
  private async project(rows: FraudCaseViewDto[], tenant: string | undefined): Promise<FraudCaseViewDto[]> {
    const summaries = await this.claims.summariesFor([...new Set(rows.flatMap((r) => r.claimIds))]);
    const byId = new Map(summaries.map((c) => [c.id, { company: c.company, plateA: c.plateA }]));
    return rows.map((r) => projectFraudCase(r, tenant, byId));
  }

  /**
   * Signaux groupés par catégorie pour un adhérent (écran 9, panneau de
   * détail) — voir `FraudSignalGroupDto`. Ne conserve que les groupes ayant
   * au moins un cas (pas de section vide affichée pour rien).
   */
  /** Revue sécurité 2026-10-18 (B.7) : `assertCompanyAccess` ajouté — avant, `company` venait du path sans aucune vérification. */
  async signalsByAdherent(company: string, user: AuthenticatedUser): Promise<FraudSignalGroupDto[]> {
    assertCompanyAccess(user, company);
    await this.whenIdle();
    const involving = await this.project((await this.readCases(company)).rows, resolveTenantFilter(user));

    const byGroup = new Map<string, FraudCaseViewDto[]>();
    for (const c of involving) {
      const group = FRAUD_CASE_TYPE_TO_GROUP[c.type as keyof typeof FRAUD_CASE_TYPE_TO_GROUP];
      if (!group) continue;
      const arr = byGroup.get(group);
      if (arr) arr.push(c);
      else byGroup.set(group, [c]);
    }

    return [...byGroup.entries()]
      .map(([group, cases]) => {
        const sorted = [...cases].sort((a, b) => b.score - a.score);
        return { group, count: sorted.length, maxScore: sorted[0].score, cases: sorted };
      })
      .sort((a, b) => b.maxScore - a.maxScore);
  }

  /** Recalcule les 5 détections à partir des données réelles et persiste (upsert idempotent par `dedupeKey`). */
  private async recompute(): Promise<void> {
    // SEC-36 : tous les dossiers, lus par lots (plus de fenêtre de 5 000).
    const { items: allClaims, truncated } = await this.claims.listAllForAnalysis();
    this.lastAnalysis = { claimsAnalyzed: allClaims.length, truncated, computedAt: new Date().toISOString() };

    const fraudClaims: FraudClaimInput[] = allClaims.map((c) => ({
      id: c.id,
      company: c.company,
      numEconstat: c.numEconstat,
      plateA: c.plateA,
      wilaya: c.wilaya,
      accidentDate: c.accidentDate,
      estimatedAmount: c.estimatedAmount,
      expertAmount: c.expertAmount,
      createdAt: c.createdAt,
    }));

    const candidates: FraudCaseCandidate[] = [
      ...detectDuplicates(fraudClaims),
      ...detectEconstatReuse(fraudClaims),
      ...detectVehicleRecurrence(fraudClaims, this.recurrenceWindowDays),
      ...detectCalibratedAmounts(fraudClaims, this.ceiling),
      ...detectVelocity(fraudClaims, this.velocitySameDayThreshold),
    ];

    // Incohérences A/B — nécessite les montants des DEUX côtés d'une paire
    // RÉELLEMENT appariée (MatchingService.listInternalPairs — id internes,
    // jamais exposés en HTTP, voir matching.service.ts).
    const pairs = await this.matching.listInternalPairs();
    const claimById = new Map(allClaims.map((c) => [c.id, c]));
    const pairAmounts: MatchedPairAmounts[] = [];
    for (const pair of pairs) {
      const a = claimById.get(pair.declAId);
      const b = claimById.get(pair.declBId);
      if (!a || !b) continue;
      pairAmounts.push({
        claimAId: a.id,
        claimBId: b.id,
        companyA: a.company,
        companyB: b.company,
        amountA: a.expertAmount ?? a.estimatedAmount,
        amountB: b.expertAmount ?? b.estimatedAmount,
        wilayaA: a.wilaya,
        wilayaB: b.wilaya,
        dateA: a.accidentDate,
        dateB: b.accidentDate,
        criteresA: { nombreVehicules: a.nombreVehicules, territoire: a.territoire, dommagesCorporelsDeclares: a.dommagesCorporelsDeclares },
        criteresB: { nombreVehicules: b.nombreVehicules, territoire: b.territoire, dommagesCorporelsDeclares: b.dommagesCorporelsDeclares },
      });
    }
    candidates.push(...detectAbInconsistencies(pairAmounts));

    await this.persistCases(candidates);

    // Transmission tardive — journal (B.9), idempotent par claimId.
    for (const c of allClaims) {
      if (!c.accidentDate) continue;
      const accident = new Date(c.accidentDate);
      const created = new Date(c.createdAt);
      if (Number.isNaN(accident.getTime())) continue;
      const delayDays = (created.getTime() - accident.getTime()) / 86_400_000;
      if (delayDays > this.transmissionLateDays) {
        await this.logActionIfAbsent('TRANSMISSION_TARDIVE', c.company, c.id, { delayDays: Math.round(delayDays) });
      }
    }
  }

  private async persistCases(candidates: FraudCaseCandidate[]): Promise<void> {
    for (const candidate of candidates) {
      const dedupeKey = `${candidate.type}:${[...candidate.claimIds].sort().join(',')}`;
      await withDegradedFallback(
        'FraudService.persistCases',
        async () => {
          let entity = await this.caseRepo.findOne({ dedupeKey });
          if (!entity) {
            entity = this.caseRepo.create({
              dedupeKey,
              type: candidate.type,
              score: candidate.score,
              severity: candidate.severity,
              claimIds: candidate.claimIds,
              companiesInvolved: candidate.companiesInvolved,
              details: candidate.details,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);
            this.caseRepo.getEntityManager().persist(entity);
          } else {
            entity.score = candidate.score;
            entity.severity = candidate.severity;
            entity.details = candidate.details;
            entity.companiesInvolved = candidate.companiesInvolved;
          }
          await this.caseRepo.getEntityManager().flush();
        },
        () => {
          const existing = this.memoryCases.find((c) => c.dedupeKey === dedupeKey);
          if (existing) {
            existing.score = candidate.score;
            existing.severity = candidate.severity;
            existing.details = candidate.details;
            existing.companiesInvolved = candidate.companiesInvolved;
          } else {
            this.memoryCases.push({
              id: randomUUID(),
              dedupeKey,
              type: candidate.type,
              score: candidate.score,
              severity: candidate.severity,
              claimIds: candidate.claimIds,
              companiesInvolved: candidate.companiesInvolved,
              details: candidate.details,
              detectedAt: new Date().toISOString(),
            });
          }
        },
      );
    }
  }
}
