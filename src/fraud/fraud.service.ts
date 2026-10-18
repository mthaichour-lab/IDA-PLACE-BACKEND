import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
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

type MemoryFraudCase = FraudCaseViewDto & { dedupeKey: string };

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
export class FraudService {
  private readonly logger = new Logger('FraudService');
  private readonly memoryCases: MemoryFraudCase[] = [];
  private readonly memoryActions: FraudActionViewDto[] = [];
  private readonly ceiling: number;
  private readonly recurrenceWindowDays: number;
  private readonly transmissionLateDays: number;
  private readonly velocitySameDayThreshold: number;

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

  async actions(page: number, pageSize: number): Promise<PaginatedResult<FraudActionViewDto>> {
    const rows = await withDegradedFallback(
      'FraudService.actions',
      async () => {
        const all = await this.actionRepo.findAll({ orderBy: { at: 'DESC' }, limit: 5000 });
        return all.map((e) => this.toActionView(e));
      },
      () => [...this.memoryActions].sort((a, b) => (a.at < b.at ? 1 : -1)),
    );
    return paginateArray(rows, page, pageSize);
  }

  async cases(page: number, pageSize: number): Promise<PaginatedResult<FraudCaseViewDto>> {
    const rows = await this.allCasesWithPlate();
    rows.sort((a, b) => b.score - a.score);
    return paginateArray(rows, page, pageSize);
  }

  /** Toutes les affaires, triées par score, enrichies de `plateA` (jointure réelle sur le premier dossier lié — jamais fabriquée). */
  private async allCasesWithPlate(): Promise<FraudCaseViewDto[]> {
    await this.recompute();
    const [rows, { items: allClaims }] = await Promise.all([
      withDegradedFallback<FraudCaseViewDto[]>(
        'FraudService.cases',
        async () => {
          const all = await this.caseRepo.findAll({ limit: 5000 });
          return all.map((e) => ({
            id: e.id,
            type: e.type,
            score: e.score,
            severity: e.severity,
            claimIds: e.claimIds,
            companiesInvolved: e.companiesInvolved,
            details: e.details,
            detectedAt: (e.updatedAt ?? e.detectedAt).toISOString(),
          }));
        },
        () => this.memoryCases.map(({ dedupeKey: _dedupeKey, ...rest }) => rest),
      ),
      this.claims.list({ page: 1, pageSize: 100_000 }),
    ]);
    const plateByClaimId = new Map(allClaims.map((c) => [c.id, c.plateA]));
    return rows.map((r) => ({ ...r, plateA: r.claimIds.map((id) => plateByClaimId.get(id)).find((p) => p) }));
  }

  /**
   * Signaux groupés par catégorie pour un adhérent (écran 9, panneau de
   * détail) — voir `FraudSignalGroupDto`. Ne conserve que les groupes ayant
   * au moins un cas (pas de section vide affichée pour rien).
   */
  async signalsByAdherent(company: string): Promise<FraudSignalGroupDto[]> {
    const all = await this.allCasesWithPlate();
    const involving = all.filter((c) => c.companiesInvolved.includes(company));

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
    const { items: allClaims } = await this.claims.list({ page: 1, pageSize: 100_000 });

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
