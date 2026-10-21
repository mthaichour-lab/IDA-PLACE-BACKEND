import { InjectRepository } from '@mikro-orm/nestjs';
import { FilterQuery } from '@mikro-orm/core';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { AdherentsService } from '../adherents/adherents.service';
import { MemoryBusinessRefCounter, nextBusinessRef } from '../common/business-ref/business-ref';
import { DEFAULT_PAGE_SIZE, paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { logDegraded, withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { resolveTenantFilter } from '../common/rbac/tenant-scope';
import { PLACE_ROOM, RealtimeGateway, tenantRoom } from '../realtime/realtime.module';
import {
  MatchDecisionDto,
  MatchDecisionHistoryDto,
  MatchDecisionResultDto,
  MatchItemDetailDto,
  MatchQueueItemDto,
  MatchQueueQueryDto,
  MatchThresholdsDto,
} from './dto/matching.dto';
import { MatchLevel, MatchQueueItem, MatchStatus } from './entities/match-queue-item.entity';
import { compactResponsabilite, computeDivergence, withTauxSelonBareme } from './matching.bareme';
import { MatchDecision } from './entities/match-decision.entity';
import { actorLabelFor, isDisclosed, PLACE_ACTOR, projectForViewer } from './matching.projection';
import { levelForScore, MatchLevelThresholds, MatchScoreResult } from './matching.scoring';
import { CandidateSelection, MatchCandidateIndex, matchKeysFor, NON_INDEXED_MAX_SCORE, selectBestCandidate } from './matching.selection';
import { ClaimMatchInput, MatchCandidateSource } from './matching.types';

/** SEC-28 — entrée d'historique (forme commune base / repli mémoire). */
interface MatchDecisionHistoryRow {
  id: string;
  matchId: string;
  action: string;
  previousStatus: string;
  newStatus: string;
  reason?: string;
  linkDeclId?: string;
  decidedBy: string;
  decidedById: string;
  decidedByRole: string;
  decidedByCompany?: string;
  decidedAt: string;
}

/** Ligne de file en repli mémoire — forme `MatchQueueItemDto` + les id internes utiles au recalcul. */
type MemoryMatchRow = MatchQueueItemDto & { declAId: string; declBId?: string };

/**
 * Retire les champs internes (`declAId`/`declBId`, absents du contrat
 * `MatchQueueItemDto`) avant toute sortie — réponse HTTP ou payload
 * temps réel. Sans ceci, le repli mémoire (mode dégradé) laisserait fuiter
 * ces identifiants internes dans `GET /matching/queue`, car l'objet mémoire
 * les porte directement (voir `upsertRowForClaim`).
 */
function toPublicDto(row: MemoryMatchRow): MatchQueueItemDto {
  const { declAId: _declAId, declBId: _declBId, ...rest } = row;
  return { ...rest, divergence: computeDivergence(rest.responsabiliteA, rest.responsabiliteB) };
}

const TERMINAL_STATUSES = new Set<string>([MatchStatus.CONFIRME_MANUEL, MatchStatus.REJETE, MatchStatus.COMPLEMENT]);

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function toDto(e: MatchQueueItem): MatchQueueItemDto {
  return {
    id: e.id,
    reference: e.reference,
    refA: e.refA,
    companyA: e.companyA,
    plateA: e.plateA,
    refB: e.refB,
    companyB: e.companyB,
    plateB: e.plateB,
    score: e.score,
    level: e.level,
    status: e.status,
    econstatShared: e.econstatShared,
    criteria: e.criteria,
    confirmedBy: e.confirmedBy,
    confirmedByCompany: e.confirmedByCompany,
    confirmedAt: e.confirmedAt?.toISOString(),
    rejectReason: e.rejectReason,
    at: e.at.toISOString(),
    accidentDateA: e.accidentDateA,
    accidentDateB: e.accidentDateB,
    wilayaA: e.wilayaA,
    wilayaB: e.wilayaB,
    assureAIdentite: e.assureAIdentite,
    assureBIdentite: e.assureBIdentite,
    canalDeclarationA: e.canalDeclarationA,
    canalDeclarationB: e.canalDeclarationB,
    policeA: e.policeA,
    policeB: e.policeB,
    responsabiliteA: e.responsabiliteA ?? undefined,
    responsabiliteB: e.responsabiliteB ?? undefined,
    divergence: computeDivergence(e.responsabiliteA, e.responsabiliteB),
  };
}

/** Prochain statut à partir de l'action de décision — B.5 (Art. 14, validation humaine). */
function nextStatusForAction(action: MatchDecisionDto['action']): MatchStatus {
  switch (action) {
    case 'confirm':
    case 'link':
      return MatchStatus.CONFIRME_MANUEL;
    case 'reject':
      return MatchStatus.REJETE;
    case 'complement':
      return MatchStatus.COMPLEMENT;
  }
}

/**
 * MatchingModule — écran 2. Clé d'appariement + score pondéré — B.5.
 *
 * La logique de calcul (clé exacte/composite, score pondéré 0-100) est
 * déléguée aux fonctions pures de `matching.scoring.ts` (testées sans Nest
 * ni base de données, voir `matching.scoring.spec.ts`). Ce service n'ajoute
 * que la persistance (`MatchQueueItem`, repli mémoire en mode dégradé — voir
 * README "Mode dégradé") et l'orchestration : une ligne de la file = une
 * déclaration (`declAId`), appariée ou non avec sa meilleure contrepartie
 * trouvée (`declBId`) — cohérent avec l'écran 2 "Réf./Partie A/Partie B".
 *
 * `MatchingModule` n'importe jamais l'entité `Claim` (ClaimsModule) :
 * `ClaimsService` lui fournit les données nécessaires via `ClaimMatchInput`
 * (interface publique, voir matching.types.ts) — c'est `ClaimsModule` qui
 * dépend de `MatchingModule`, jamais l'inverse (pas de cycle).
 *
 * NE PAS changer la forme des DTO ni des routes `/matching/queue` et
 * `/matching/{id}/decide` (contrat stable, voir HANDOFF.md).
 */
@Injectable()
export class MatchingService {
  /** Repli mémoire — mode dégradé (base injoignable). Persistant pour la durée du process. */
  private readonly memory: MemoryMatchRow[] = [];
  private readonly memoryRefs = new MemoryBusinessRefCounter();
  /** SEC-28 : historique des décisions en repli mémoire. */
  private readonly memoryDecisions: MatchDecisionHistoryRow[] = [];
  private readonly logger = new Logger('MatchingService');
  private readonly thresholds: MatchLevelThresholds;

  constructor(
    @InjectRepository(MatchQueueItem) private readonly repo: EntityRepository<MatchQueueItem>,
    private readonly configService: ConfigService,
    private readonly realtime: RealtimeGateway,
    private readonly adherents: AdherentsService,
  ) {
    // Seuils paramétrables (B.5) — variables d'environnement plutôt qu'en
    // dur (80/50 restent les valeurs par défaut documentées par le dossier).
    this.thresholds = {
      autoThreshold: Number(this.configService.get<string>('MATCHING_AUTO_THRESHOLD') ?? 80),
      confirmThreshold: Number(this.configService.get<string>('MATCHING_CONFIRM_THRESHOLD') ?? 50),
    };
  }

  getThresholds(): MatchThresholdsDto {
    return { ...this.thresholds };
  }

  /**
   * SEC-13 — critères de la file traduits en requête : filtre tenant et
   * onglet appliqués EN BASE, avant la pagination (plus de chargement de
   * toute la table pour chaque lecture).
   */
  private whereFor(tenant: string | undefined, filter?: string): FilterQuery<MatchQueueItem> {
    const and: FilterQuery<MatchQueueItem>[] = [];
    if (tenant) and.push({ $or: [{ companyA: tenant }, { companyB: tenant }] });
    if (filter === 'AUTO') and.push({ level: MatchLevel.AUTO });
    if (filter === 'A_CONFIRMER') and.push({ status: MatchStatus.A_CONFIRMER });
    if (filter === 'NON_APPARIES') and.push({ refB: null });
    return and.length > 0 ? { $and: and } : {};
  }

  /** Équivalent mémoire de `whereFor` (mode dégradé). */
  private memoryRows(tenant: string | undefined, filter?: string): MatchQueueItemDto[] {
    return [...this.memory]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1))
      .map(toPublicDto)
      .filter((r) => !tenant || r.companyA === tenant || r.companyB === tenant)
      .filter((r) => filter !== 'AUTO' || r.level === 'AUTO')
      .filter((r) => filter !== 'A_CONFIRMER' || r.status === 'A_CONFIRMER')
      .filter((r) => filter !== 'NON_APPARIES' || !r.refB);
  }

  /** B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que les lignes où sa compagnie est `companyA` ou `companyB` ; les rôles "place" voient tout. Ajouté en continuité de la revue Product Owner (même angle mort que Claims/Recours/Settlement/Commission, repéré après coup sur ce module "figé" du sprint 2 — filtrer les lignes retournées ne change pas la forme du DTO/de la route). */
  private visibleToUser(r: { companyA: string; companyB?: string }, user?: AuthenticatedUser): boolean {
    if (!user) return true;
    const tenant = resolveTenantFilter(user);
    if (!tenant) return true;
    return r.companyA === tenant || r.companyB === tenant;
  }

  async queue(query: MatchQueueQueryDto, user?: AuthenticatedUser): Promise<PaginatedResult<MatchQueueItemDto>> {
    const tenant = user ? resolveTenantFilter(user) : undefined;
    const page = Math.max(1, query.page ?? 1);
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const { items, total } = await withDegradedFallback(
      'MatchingService.queue',
      async () => {
        const [rows, count] = await this.repo.findAndCount(this.whereFor(tenant, query.filter), {
          orderBy: { at: 'DESC', id: 'ASC' },
          limit: pageSize,
          offset: (page - 1) * pageSize,
        });
        return { items: rows.map(toDto), total: count };
      },
      () => {
        const p = paginateArray(this.memoryRows(tenant, query.filter), page, pageSize);
        return { items: p.items, total: p.total };
      },
    );
    // SEC-03 : barème calculé sur les données complètes, PUIS masquage pour le lecteur.
    const projected = (await this.withBareme(items)).map((r) => projectForViewer(r, tenant));
    return new PaginatedResult(projected, total, page);
  }

  /** Détail d'un appariement (écran 2), avec les deux saisies Art. 14 côte à côte. */
  /**
   * Le détail, déjà scopé par compagnie, expose les id des deux dossiers
   * (`claimAId`/`claimBId`) pour la saisie Art. 14 (`PATCH
   * /claims/:id/responsabilite`) ; la file, elle, ne les publie pas.
   */
  /** Même raison que `CommissionService.loadCaseForMutation` : un 404 métier ne doit jamais déclencher le repli mémoire. */
  private async loadForDecision(id: string): Promise<{ mode: 'db'; entity: MatchQueueItem } | { mode: 'memory'; row: MemoryMatchRow }> {
    try {
      const entity = await this.repo.findOne({ id });
      if (entity) return { mode: 'db', entity };
    } catch (err) {
      logDegraded('MatchingService.loadForDecision', `base de données injoignable (${(err as Error).message}) — repli mémoire`);
    }
    const row = this.memory.find((r) => r.id === id);
    if (row) return { mode: 'memory', row };
    throw new NotFoundException({ code: 'NOT_FOUND', message: 'Élément de confrontation introuvable.' });
  }

  /** SEC-13 : lecture d'UNE ligne par id (plus de chargement de toute la table) ; 404/403 levés hors du repli. */
  async getItem(id: string, user?: AuthenticatedUser): Promise<MatchItemDetailDto> {
    const found = await withDegradedFallback(
      'MatchingService.getItem',
      async () => {
        const e = await this.repo.findOne({ id });
        return e ? { row: toDto(e), claimAId: e.declAId, claimBId: e.declBId ?? undefined } : undefined;
      },
      () => {
        const m = this.memory.find((r) => r.id === id);
        return m ? { row: toPublicDto(m), claimAId: m.declAId, claimBId: m.declBId } : undefined;
      },
    );
    if (!found) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Élément de confrontation introuvable.' });
    const { row, ...ids } = found;
    if (!this.visibleToUser(row, user)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
    const [withBareme] = await this.withBareme([row]);
    const tenant = user ? resolveTenantFilter(user) : undefined;
    const projected = projectForViewer({ ...withBareme, claimAId: ids.claimAId ?? '', claimBId: ids.claimBId }, tenant);
    // SEC-03 : l'id du dossier de l'autre compagnie n'est publié qu'après confirmation (il ouvrirait `GET /claims/:id`).
    if (projected.masked) {
      if (projected.companyA !== tenant) projected.claimAId = '';
      if (projected.companyB !== tenant) projected.claimBId = undefined;
    }
    return projected;
  }

  /** Taux selon barème calculé à la lecture : une version archivée entre-temps n'est plus citée. */
  private async withBareme(rows: MatchQueueItemDto[]): Promise<MatchQueueItemDto[]> {
    if (!rows.some((r) => r.responsabiliteA?.baremeCode || r.responsabiliteB?.baremeCode)) return rows;
    const cases = await this.adherents.publishedBaremeCases();
    return rows.map((r) => ({ ...r, responsabiliteA: withTauxSelonBareme(r.responsabiliteA, cases), responsabiliteB: withTauxSelonBareme(r.responsabiliteB, cases) }));
  }

  /**
   * Rafraîchit la saisie Art. 14 d'une déclaration sur toutes les lignes qui
   * la portent (côté A ou B), y compris une ligne déjà tranchée : ce n'est
   * qu'un affichage, la décision humaine n'est pas touchée.
   */
  async refreshDeclaration(claim: ClaimMatchInput): Promise<void> {
    const block = compactResponsabilite(claim.responsabilite);
    await withDegradedFallback(
      'MatchingService.refreshDeclaration',
      async () => {
        const rows = await this.repo.find({ $or: [{ declAId: claim.id }, { declBId: claim.id }] });
        for (const r of rows) {
          if (r.declAId === claim.id) r.responsabiliteA = block;
          if (r.declBId === claim.id) r.responsabiliteB = block;
        }
        await this.repo.getEntityManager().flush();
      },
      () => {
        for (const r of this.memory) {
          if (r.declAId === claim.id) r.responsabiliteA = block;
          if (r.declBId === claim.id) r.responsabiliteB = block;
        }
      },
    );
  }

  /**
   * Paires appariées (déclaration A / déclaration B) avec leurs id `Claim`
   * internes (`declAId`/`declBId`), pour un module RÉEL qui a besoin de
   * ré-interroger `ClaimsService` par id (ex. `FraudModule` — incohérences
   * A/B, B.9) — contrairement à `MatchQueueItemDto` (contrat HTTP stable),
   * ces id ne sont jamais exposés en dehors du back-end. Ne retourne que les
   * lignes effectivement appariées (`declBId` défini).
   */
  async listInternalPairs(): Promise<Array<{ declAId: string; declBId: string; score: number; status: string }>> {
    return withDegradedFallback(
      'MatchingService.listInternalPairs',
      async () => {
        const rows = await this.repo.find({ declBId: { $ne: null } });
        return rows.map((r) => ({ declAId: r.declAId, declBId: r.declBId as string, score: r.score, status: r.status }));
      },
      () =>
        this.memory
          .filter((r) => !!r.declBId)
          .map((r) => ({ declAId: r.declAId, declBId: r.declBId as string, score: r.score, status: r.status })),
    );
  }

  /**
   * SEC-03/SEC-26 — parmi `claimIds`, dossiers appariés de manière confirmée
   * (AUTO_CONFIRME ou CONFIRME_MANUEL) dans une paire où `tenant` est
   * partie : leurs champs nominatifs peuvent être publiés à `tenant`
   * (`ClaimsService`, lecture d'un dossier d'une autre compagnie).
   */
  async disclosedClaimIds(claimIds: string[], tenant: string): Promise<Set<string>> {
    if (claimIds.length === 0) return new Set();
    const wanted = new Set(claimIds);
    const disclosedStatuses = [MatchStatus.AUTO_CONFIRME, MatchStatus.CONFIRME_MANUEL];
    const pairs = await withDegradedFallback<Array<{ declAId: string; declBId?: string }>>(
      'MatchingService.disclosedClaimIds',
      async () =>
        this.repo.find({
          $and: [
            { status: { $in: disclosedStatuses } },
            { $or: [{ declAId: { $in: claimIds } }, { declBId: { $in: claimIds } }] },
            { $or: [{ companyA: tenant }, { companyB: tenant }] },
          ],
        }),
      () =>
        this.memory.filter(
          (r) => isDisclosed(r.status) && (wanted.has(r.declAId) || (!!r.declBId && wanted.has(r.declBId))) && (r.companyA === tenant || r.companyB === tenant),
        ),
    );
    const out = new Set<string>();
    for (const p of pairs) {
      if (wanted.has(p.declAId)) out.add(p.declAId);
      if (p.declBId && wanted.has(p.declBId)) out.add(p.declBId);
    }
    return out;
  }

  /** SEC-13 : compteurs calculés en base (COUNT), filtre tenant compris. */
  async counters(user?: AuthenticatedUser): Promise<Record<string, number>> {
    const tenant = user ? resolveTenantFilter(user) : undefined;
    const tabs = ['TOUS', 'AUTO', 'A_CONFIRMER', 'NON_APPARIES'] as const;
    return withDegradedFallback(
      'MatchingService.counters',
      async () => {
        const counts = await Promise.all(tabs.map((t) => this.repo.count(this.whereFor(tenant, t))));
        return Object.fromEntries(tabs.map((t, i) => [t, counts[i]]));
      },
      () => Object.fromEntries(tabs.map((t) => [t, this.memoryRows(tenant, t).length])),
    );
  }

  /**
   * Une confirmation ou un rejet porte sur la PAIRE : il s'applique aussi à la
   * ligne miroir (B↔A), si elle n'a pas déjà été tranchée. Un rattachement
   * manuel (`link`) vise une autre déclaration et ne se propage pas.
   * Lecture, puis contrôle de périmètre, puis écriture : un 404/403 levé dans
   * la closure de `withDegradedFallback` serait pris pour une panne DB.
   */
  /**
   * SEC-28 — déclaration à lier : elle doit figurer dans la file (404 sinon),
   * ne pas être la déclaration elle-même, et relever d'une autre compagnie
   * que la déclaration A (un rattachement relie deux compagnies).
   */
  private async assertLinkTarget(current: { declAId: string; companyA: string }, linkDeclId: string | undefined): Promise<void> {
    if (!linkDeclId) throw new BadRequestException({ code: 'LIEN_REQUIS', message: 'action=link : linkDeclId (identifiant de la déclaration à lier) est obligatoire.' });
    if (linkDeclId === current.declAId) throw new BadRequestException({ code: 'LIEN_INVALIDE', message: 'Une déclaration ne peut pas être liée à elle-même.' });
    const target = await withDegradedFallback(
      'MatchingService.assertLinkTarget',
      async () => {
        const e = await this.repo.findOne({ declAId: linkDeclId });
        return e ? { companyA: e.companyA } : undefined;
      },
      () => this.memory.find((r) => r.declAId === linkDeclId),
    );
    if (!target) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Déclaration à lier introuvable.' });
    if (target.companyA === current.companyA) {
      throw new BadRequestException({ code: 'LIEN_INVALIDE', message: 'La déclaration liée doit relever d’une autre compagnie.' });
    }
  }

  /** SEC-28 — historique des décisions d'une ligne (même périmètre que le détail), auteurs d'autres compagnies masqués. */
  async decisionHistory(id: string, user?: AuthenticatedUser): Promise<MatchDecisionHistoryDto[]> {
    await this.getItem(id, user); // 404 / 403 hors périmètre
    const tenant = user ? resolveTenantFilter(user) : undefined;
    const rows = await withDegradedFallback<MatchDecisionHistoryRow[]>(
      'MatchingService.decisionHistory',
      async () => {
        const ents = await this.repo.getEntityManager().find(MatchDecision, { matchId: id }, { orderBy: { decidedAt: 'ASC', id: 'ASC' } });
        return ents.map((e) => ({ ...e, reason: e.reason ?? undefined, linkDeclId: e.linkDeclId ?? undefined, decidedByCompany: e.decidedByCompany ?? undefined, decidedAt: e.decidedAt.toISOString() }));
      },
      () => this.memoryDecisions.filter((d) => d.matchId === id),
    );
    return rows.map((d) => ({
      id: d.id,
      action: d.action,
      previousStatus: d.previousStatus,
      newStatus: d.newStatus,
      reason: d.reason,
      linkDeclId: d.linkDeclId,
      decidedBy: actorLabelFor(d.decidedBy, d.decidedByCompany ?? PLACE_ACTOR, tenant) ?? '',
      decidedByRole: d.decidedByRole,
      decidedByCompany: d.decidedByCompany,
      decidedAt: d.decidedAt,
    }));
  }

  async decide(id: string, dto: MatchDecisionDto, decidedBy: string, user?: AuthenticatedUser): Promise<MatchDecisionResultDto> {
    const loaded = await this.loadForDecision(id);
    const current = loaded.mode === 'db' ? loaded.entity : loaded.row;
    if (!this.visibleToUser(current, user)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
    // Audit sécurité 2026-10-19 : trancher une confrontation ne doit pas non
    // plus engager une compagnie qui n'est plus ACTIF (même règle que
    // ClaimsService.openRecours, un côté comme l'autre).
    await this.adherents.assertCompanyActiveFor(current.companyA, current.accidentDateA);
    if (current.companyB) await this.adherents.assertCompanyActiveFor(current.companyB, current.accidentDateB);
    // SEC-28 : revenir sur une décision déjà prise exige un motif ; un
    // rattachement manuel exige une déclaration valide du périmètre.
    if (isTerminal(current.status) && !dto.reason?.trim()) {
      throw new BadRequestException({ code: 'MOTIF_REQUIS', message: 'Cette confrontation a déjà été tranchée : une nouvelle décision doit être motivée (reason).' });
    }
    if (dto.action === 'link') await this.assertLinkTarget(current, dto.linkDeclId);
    const status = nextStatusForAction(dto.action);
    const symmetric = dto.action === 'confirm' || dto.action === 'reject';
    const now = new Date();
    const actorCompany = (user ? resolveTenantFilter(user) : undefined) ?? PLACE_ACTOR;
    const historyFor = (t: { id: string; status: string }): Omit<MatchDecisionHistoryRow, 'id'> => ({
      matchId: t.id,
      action: dto.action,
      previousStatus: t.status,
      newStatus: status,
      reason: dto.reason?.trim() || undefined,
      linkDeclId: dto.action === 'link' ? dto.linkDeclId : undefined,
      decidedBy,
      decidedById: user?.id ?? decidedBy,
      decidedByRole: user?.role ?? 'INCONNU',
      decidedByCompany: actorCompany === PLACE_ACTOR ? undefined : actorCompany,
      decidedAt: now.toISOString(),
    });

    let result: MatchQueueItemDto;
    let mirrorResult: MatchQueueItemDto | undefined;
    if (loaded.mode === 'db') {
      const item = loaded.entity;
      const targets = [item];
      const mirror = symmetric && item.declBId ? await this.repo.findOne({ declAId: item.declBId, declBId: item.declAId }) : null;
      if (mirror && !isTerminal(mirror.status)) targets.push(mirror);
      const em = this.repo.getEntityManager();
      for (const t of targets) {
        // SEC-28 : historique écrit dans la même unité de travail que la décision.
        const h = historyFor(t);
        em.persist(em.create(MatchDecision, { ...h, decidedAt: now }));
        t.status = status;
        t.confirmedBy = decidedBy;
        t.confirmedByCompany = actorCompany;
        t.confirmedAt = now;
        if (dto.action === 'reject') t.rejectReason = dto.reason;
      }
      if (dto.action === 'link' && dto.linkDeclId) item.linkedDeclId = dto.linkDeclId;
      await em.flush();
      result = toDto(item);
      if (targets.length > 1) mirrorResult = toDto(targets[1]);
    } else {
      const item = loaded.row;
      const targets = [item];
      const mirror = symmetric && item.declBId ? this.memory.find((r) => r.declAId === item.declBId && r.declBId === item.declAId) : undefined;
      if (mirror && !isTerminal(mirror.status)) targets.push(mirror);
      for (const t of targets) {
        this.memoryDecisions.push({ id: randomUUID(), ...historyFor(t) });
        t.status = status;
        t.confirmedBy = decidedBy;
        t.confirmedByCompany = actorCompany;
        t.confirmedAt = now.toISOString();
        if (dto.action === 'reject') t.rejectReason = dto.reason;
      }
      result = toPublicDto(item);
      if (targets.length > 1) mirrorResult = toPublicDto(targets[1]);
    }

    const decision: MatchDecisionResultDto = {
      id: result.id,
      status: result.status,
      decidedAt: result.confirmedAt!,
      decidedBy,
    };
    // B.12 — événement temps réel après toute décision de confrontation.
    // SEC-07 : salons des seules parties (+ place), payload minimal sans
    // plaque, identité, police ni nom d'agent ; la ligne complète reste
    // réservée aux abonnés internes (FraudModule, journal des actions).
    this.emitMatchDecision(result, decision);
    if (mirrorResult) this.emitMatchDecision(mirrorResult, { ...decision, id: mirrorResult.id });
    return decision;
  }

  /**
   * Calcule la meilleure contrepartie de `claim` parmi `pool` (clé exacte en
   * priorité, sinon score pondéré composite le plus élevé) et met à jour
   * (ou crée) la ligne de file correspondant à `claim` (`declAId`). Ne
   * touche pas une ligne déjà tranchée humainement (statut terminal — Art.
   * 14, validation humaine obligatoire) : seuls le score affiché par défaut
   * (AUTO/A_CONFIRMER) sont recalculés automatiquement.
   */
  /**
   * SEC-03 : meilleure contrepartie DÉSIGNÉE au-dessus du seuil MANUEL
   * (`confirmThreshold`), départage déterministe journalisé — voir
   * `matching.selection.ts`. `index` évite de rescorer toute la base (SEC-12).
   */
  private pickBest(claim: ClaimMatchInput, index: MatchCandidateIndex, useKeys: boolean): CandidateSelection | undefined {
    const pool = useKeys ? index.candidatesFor(claim) : index.all();
    const best = selectBestCandidate(claim, pool, this.thresholds.confirmThreshold);
    if (best?.tieBroken) {
      this.logger.log(`Égalité de score (${best.result.score}) pour la déclaration ${claim.id} : départage par date de réception puis id → ${best.candidate.id}.`);
    }
    return best;
  }

  private async upsertRowForClaim(
    claim: ClaimMatchInput,
    best: { candidate: ClaimMatchInput; result: MatchScoreResult } | undefined,
  ): Promise<void> {
    await withDegradedFallback(
      'MatchingService.upsertRowForClaim',
      async () => {
        let item = await this.repo.findOne({ declAId: claim.id });
        if (item && isTerminal(item.status)) return; // décision humaine préservée (Art. 14)
        if (!item) {
          // Référence attribuée une seule fois, à la création de la ligne : les recalculs (upsert) ne la touchent jamais.
          const at = new Date();
          const reference = await nextBusinessRef(this.repo.getEntityManager(), 'MAT', at);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          item = this.repo.create({ declAId: claim.id, reference, at } as any);
          this.repo.getEntityManager().persist(item);
        }
        this.applyComputed(item, claim, best);
        await this.repo.getEntityManager().flush();
      },
      () => {
        let item = this.memory.find((r) => r.declAId === claim.id);
        if (item && isTerminal(item.status)) return;
        if (!item) {
          const at = new Date();
          item = { id: randomUUID(), reference: this.memoryRefs.next('MAT', at), declAId: claim.id, at: at.toISOString() } as MemoryMatchRow;
          this.memory.push(item);
        }
        this.applyComputedDto(item, claim, best);
      },
    );
  }

  private applyComputed(
    item: MatchQueueItem,
    claim: ClaimMatchInput,
    best?: { candidate: ClaimMatchInput; result: MatchScoreResult },
  ): void {
    item.declAId = claim.id;
    item.refA = claim.numEconstat ?? claim.id;
    item.companyA = claim.company;
    item.plateA = claim.plateA ?? '—';
    item.accidentDateA = claim.accidentDate;
    item.wilayaA = claim.wilaya;
    item.assureAIdentite = claim.assureIdentite;
    item.canalDeclarationA = claim.canalDeclaration;
    item.policeA = claim.policeA;
    item.responsabiliteA = compactResponsabilite(claim.responsabilite);
    if (best) {
      item.declBId = best.candidate.id;
      item.refB = best.candidate.numEconstat ?? best.candidate.id;
      item.companyB = best.candidate.company;
      item.plateB = best.candidate.plateA ?? '—';
      item.score = best.result.score;
      item.econstatShared = best.result.econstatShared;
      item.criteria = best.result.criteria;
      item.level = levelForScore(best.result.score, this.thresholds) as MatchLevel;
      item.accidentDateB = best.candidate.accidentDate;
      item.wilayaB = best.candidate.wilaya;
      item.assureBIdentite = best.candidate.assureIdentite;
      item.canalDeclarationB = best.candidate.canalDeclaration;
      item.policeB = best.candidate.policeA;
      item.responsabiliteB = compactResponsabilite(best.candidate.responsabilite);
    } else {
      item.declBId = undefined;
      item.refB = undefined;
      item.companyB = undefined;
      item.plateB = undefined;
      item.score = 0;
      item.econstatShared = false;
      item.criteria = { econstatPartage: false, plaquesCroisees: false, policeCroisee: false, dateHeure: false, compagniesCroisees: false, gps: false };
      item.level = MatchLevel.NON;
      item.accidentDateB = undefined;
      item.wilayaB = undefined;
      item.assureBIdentite = undefined;
      item.canalDeclarationB = undefined;
      item.policeB = undefined;
      item.responsabiliteB = undefined;
    }
    if (!item.status || !isTerminal(item.status)) {
      item.status = item.level === MatchLevel.AUTO ? MatchStatus.AUTO_CONFIRME : MatchStatus.A_CONFIRMER;
    }
  }

  private applyComputedDto(
    item: MemoryMatchRow,
    claim: ClaimMatchInput,
    best?: { candidate: ClaimMatchInput; result: MatchScoreResult },
  ): void {
    item.declAId = claim.id;
    item.refA = claim.numEconstat ?? claim.id;
    item.companyA = claim.company;
    item.plateA = claim.plateA ?? '—';
    item.at = item.at ?? new Date().toISOString();
    item.accidentDateA = claim.accidentDate;
    item.wilayaA = claim.wilaya;
    item.assureAIdentite = claim.assureIdentite;
    item.canalDeclarationA = claim.canalDeclaration;
    item.policeA = claim.policeA;
    item.responsabiliteA = compactResponsabilite(claim.responsabilite);
    if (best) {
      item.declBId = best.candidate.id;
      item.refB = best.candidate.numEconstat ?? best.candidate.id;
      item.companyB = best.candidate.company;
      item.plateB = best.candidate.plateA ?? '—';
      item.score = best.result.score;
      item.econstatShared = best.result.econstatShared;
      item.criteria = best.result.criteria;
      item.level = levelForScore(best.result.score, this.thresholds);
      item.accidentDateB = best.candidate.accidentDate;
      item.wilayaB = best.candidate.wilaya;
      item.assureBIdentite = best.candidate.assureIdentite;
      item.canalDeclarationB = best.candidate.canalDeclaration;
      item.policeB = best.candidate.policeA;
      item.responsabiliteB = compactResponsabilite(best.candidate.responsabilite);
    } else {
      item.declBId = undefined;
      item.refB = undefined;
      item.companyB = undefined;
      item.plateB = undefined;
      item.score = 0;
      item.econstatShared = false;
      item.criteria = { econstatPartage: false, plaquesCroisees: false, policeCroisee: false, dateHeure: false, compagniesCroisees: false, gps: false };
      item.level = 'NON';
      item.accidentDateB = undefined;
      item.wilayaB = undefined;
      item.assureBIdentite = undefined;
      item.canalDeclarationB = undefined;
      item.policeB = undefined;
      item.responsabiliteB = undefined;
    }
    if (!item.status || !isTerminal(item.status)) {
      item.status = item.level === 'AUTO' ? 'AUTO_CONFIRME' : 'A_CONFIRMER';
    }
  }

  /**
   * Point d'entrée appelé par `ClaimsModule` après ingestion d'une nouvelle
   * déclaration (import). Recalcule la ligne de file de `newClaim`, et — si
   * une contrepartie a été trouvée — recalcule aussi la ligne de cette
   * contrepartie (pour qu'elle reflète elle aussi le nouvel appariement,
   * dans les deux sens). Émet `claim.ingested`-adjacent via `match.updated`
   * uniquement si un appariement a réellement été (re)calculé.
   */
  async ingestClaim(newClaim: ClaimMatchInput, allExistingClaims: ClaimMatchInput[]): Promise<void> {
    await this.ingestClaims([newClaim], { byKeys: async () => allExistingClaims, all: async () => allExistingClaims });
  }

  /**
   * Ingestion par lot (import) — SEC-12 : un seul index en mémoire des
   * déclarations candidates (chargées par clé de rapprochement via
   * `source.byKeys`, requête indexée côté ClaimsModule) au lieu d'un
   * rescoring de toute la base pour chaque ligne (O(n²)). Tant que le seuil
   * de rétention dépasse `NON_INDEXED_MAX_SCORE`, l'index est exact ; sinon
   * repli sur `source.all()`.
   */
  async ingestClaims(newClaims: ClaimMatchInput[], source: MatchCandidateSource): Promise<void> {
    if (newClaims.length === 0) return;
    const useKeys = this.thresholds.confirmThreshold > NON_INDEXED_MAX_SCORE;
    const load = (claims: ClaimMatchInput[]) => (useKeys ? source.byKeys([...new Set(claims.flatMap(matchKeysFor))]) : source.all());

    const index = new MatchCandidateIndex(await load(newClaims));
    for (const c of newClaims) index.add(c);

    const counterparts = new Map<string, ClaimMatchInput>();
    const newIds = new Set(newClaims.map((c) => c.id));
    const outcomes: Array<{ claim: ClaimMatchInput; matchedWith?: ClaimMatchInput }> = [];
    for (const claim of newClaims) {
      const best = this.pickBest(claim, index, useKeys);
      await this.upsertRowForClaim(claim, best);
      outcomes.push({ claim, matchedWith: best?.candidate });
      if (best && !newIds.has(best.candidate.id)) counterparts.set(best.candidate.id, best.candidate);
    }

    // La contrepartie trouvée est recalculée à son tour (appariement dans les deux sens).
    if (counterparts.size > 0) {
      const extra = await load([...counterparts.values()]);
      for (const c of extra) if (!index.has(c.id)) index.add(c);
      for (const cp of counterparts.values()) {
        await this.upsertRowForClaim(cp, this.pickBest(cp, index, useKeys));
      }
    }

    // SEC-07 : seules les compagnies parties (+ place) sont notifiées ; l'id du
    // dossier de la contrepartie ne part qu'aux abonnés internes.
    for (const { claim, matchedWith } of outcomes) {
      this.realtime.emitEvent(
        'match.updated',
        { claimId: claim.id, matched: !!matchedWith },
        { rooms: partyRooms(claim.company, matchedWith?.company), internalPayload: { claimId: claim.id, matchedWith: matchedWith?.id } },
      );
    }
  }

  private emitMatchDecision(item: MatchQueueItemDto, decision: MatchDecisionResultDto): void {
    this.realtime.emitEvent(
      'match.updated',
      { id: item.id, reference: item.reference, status: item.status, level: item.level, decidedAt: decision.decidedAt },
      { rooms: partyRooms(item.companyA, item.companyB), internalPayload: { item, decision } },
    );
  }
}

/** SEC-07 : salon de place + salons des compagnies parties (sans doublon). */
export function partyRooms(...companies: Array<string | undefined>): string[] {
  return [PLACE_ROOM, ...new Set(companies.filter((c): c is string => !!c).map(tenantRoom))];
}
