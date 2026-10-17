import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { resolveTenantFilter } from '../common/rbac/tenant-scope';
import { RealtimeGateway } from '../realtime/realtime.module';
import {
  MatchDecisionDto,
  MatchDecisionResultDto,
  MatchQueueItemDto,
  MatchQueueQueryDto,
  MatchThresholdsDto,
} from './dto/matching.dto';
import { MatchLevel, MatchQueueItem, MatchStatus } from './entities/match-queue-item.entity';
import { computeMatchScore, levelForScore, MatchLevelThresholds, MatchScoreResult } from './matching.scoring';
import { ClaimMatchInput } from './matching.types';

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
  return rest;
}

const TERMINAL_STATUSES = new Set<string>([MatchStatus.CONFIRME_MANUEL, MatchStatus.REJETE, MatchStatus.COMPLEMENT]);

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function toDto(e: MatchQueueItem): MatchQueueItemDto {
  return {
    id: e.id,
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
    confirmedAt: e.confirmedAt?.toISOString(),
    rejectReason: e.rejectReason,
    at: e.at.toISOString(),
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
  private readonly thresholds: MatchLevelThresholds;

  constructor(
    @InjectRepository(MatchQueueItem) private readonly repo: EntityRepository<MatchQueueItem>,
    private readonly configService: ConfigService,
    private readonly realtime: RealtimeGateway,
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

  private async findAllDtos(): Promise<MatchQueueItemDto[]> {
    return withDegradedFallback(
      'MatchingService.findAll',
      async () => {
        const rows = await this.repo.findAll({ orderBy: { at: 'DESC' } });
        return rows.map(toDto);
      },
      () => [...this.memory].sort((a, b) => (a.at < b.at ? 1 : -1)).map(toPublicDto),
    );
  }

  /** B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que les lignes où sa compagnie est `companyA` ou `companyB` ; les rôles "place" voient tout. Ajouté en continuité de la revue Product Owner (même angle mort que Claims/Recours/Settlement/Commission, repéré après coup sur ce module "figé" du sprint 2 — filtrer les lignes retournées ne change pas la forme du DTO/de la route). */
  private visibleToUser(r: { companyA: string; companyB?: string }, user?: AuthenticatedUser): boolean {
    if (!user) return true;
    const tenant = resolveTenantFilter(user);
    if (!tenant) return true;
    return r.companyA === tenant || r.companyB === tenant;
  }

  async queue(query: MatchQueueQueryDto, user?: AuthenticatedUser): Promise<PaginatedResult<MatchQueueItemDto>> {
    let rows = await this.findAllDtos();
    rows = rows.filter((r) => this.visibleToUser(r, user));
    if (query.filter === 'AUTO') rows = rows.filter((r) => r.level === 'AUTO');
    if (query.filter === 'A_CONFIRMER') rows = rows.filter((r) => r.status === 'A_CONFIRMER');
    if (query.filter === 'NON_APPARIES') rows = rows.filter((r) => !r.refB);
    return paginateArray(rows, query.page, query.pageSize);
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
        const rows = await this.repo.findAll();
        return rows
          .filter((r) => !!r.declBId)
          .map((r) => ({ declAId: r.declAId, declBId: r.declBId as string, score: r.score, status: r.status }));
      },
      () =>
        this.memory
          .filter((r) => !!r.declBId)
          .map((r) => ({ declAId: r.declAId, declBId: r.declBId as string, score: r.score, status: r.status })),
    );
  }

  async counters(user?: AuthenticatedUser): Promise<Record<string, number>> {
    const rows = (await this.findAllDtos()).filter((r) => this.visibleToUser(r, user));
    return {
      TOUS: rows.length,
      AUTO: rows.filter((r) => r.level === 'AUTO').length,
      A_CONFIRMER: rows.filter((r) => r.status === 'A_CONFIRMER').length,
      NON_APPARIES: rows.filter((r) => !r.refB).length,
    };
  }

  async decide(id: string, dto: MatchDecisionDto, decidedBy: string, user?: AuthenticatedUser): Promise<MatchDecisionResultDto> {
    const result = await withDegradedFallback(
      'MatchingService.decide',
      async () => {
        const item = await this.repo.findOne({ id });
        if (!item) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Élément de confrontation introuvable.' });
        if (!this.visibleToUser(item, user)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
        item.status = nextStatusForAction(dto.action);
        item.confirmedBy = decidedBy;
        item.confirmedAt = new Date();
        if (dto.action === 'reject') item.rejectReason = dto.reason;
        if (dto.action === 'link' && dto.linkDeclId) item.linkedDeclId = dto.linkDeclId;
        await this.repo.getEntityManager().flush();
        return toDto(item);
      },
      () => {
        const item = this.memory.find((r) => r.id === id);
        if (!item) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Élément de confrontation introuvable (mode dégradé).' });
        if (!this.visibleToUser(item, user)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
        item.status = nextStatusForAction(dto.action);
        item.confirmedBy = decidedBy;
        item.confirmedAt = new Date().toISOString();
        if (dto.action === 'reject') item.rejectReason = dto.reason;
        return toPublicDto(item);
      },
    );

    const decision: MatchDecisionResultDto = {
      id: result.id,
      status: result.status,
      decidedAt: result.confirmedAt!,
      decidedBy,
    };
    // B.12 — événement temps réel après toute décision de confrontation.
    this.realtime.emitEvent('match.updated', { item: result, decision });
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
  private async upsertRowForClaim(
    claim: ClaimMatchInput,
    pool: ClaimMatchInput[],
  ): Promise<{ candidate?: ClaimMatchInput; result?: MatchScoreResult }> {
    let best: { candidate: ClaimMatchInput; result: MatchScoreResult } | undefined;
    for (const candidate of pool) {
      if (candidate.id === claim.id) continue;
      const result = computeMatchScore(claim, candidate);
      if (result.score > 0 && (!best || result.score > best.result.score)) {
        best = { candidate, result };
      }
    }

    await withDegradedFallback(
      'MatchingService.upsertRowForClaim',
      async () => {
        let item = await this.repo.findOne({ declAId: claim.id });
        if (item && isTerminal(item.status)) return; // décision humaine préservée (Art. 14)
        if (!item) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          item = this.repo.create({ declAId: claim.id } as any);
          this.repo.getEntityManager().persist(item);
        }
        this.applyComputed(item, claim, best);
        await this.repo.getEntityManager().flush();
      },
      () => {
        let item = this.memory.find((r) => r.declAId === claim.id);
        if (item && isTerminal(item.status)) return;
        if (!item) {
          item = { id: randomUUID(), declAId: claim.id, at: new Date().toISOString() } as MemoryMatchRow;
          this.memory.push(item);
        }
        this.applyComputedDto(item, claim, best);
      },
    );

    return best ?? {};
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
    if (best) {
      item.declBId = best.candidate.id;
      item.refB = best.candidate.numEconstat ?? best.candidate.id;
      item.companyB = best.candidate.company;
      item.plateB = best.candidate.plateA ?? '—';
      item.score = best.result.score;
      item.econstatShared = best.result.econstatShared;
      item.criteria = best.result.criteria;
      item.level = levelForScore(best.result.score, this.thresholds) as MatchLevel;
    } else {
      item.declBId = undefined;
      item.refB = undefined;
      item.companyB = undefined;
      item.plateB = undefined;
      item.score = 0;
      item.econstatShared = false;
      item.criteria = { econstatPartage: false, plaquesCroisees: false, policeCroisee: false, dateHeure: false, compagniesCroisees: false, gps: false };
      item.level = MatchLevel.NON;
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
    if (best) {
      item.declBId = best.candidate.id;
      item.refB = best.candidate.numEconstat ?? best.candidate.id;
      item.companyB = best.candidate.company;
      item.plateB = best.candidate.plateA ?? '—';
      item.score = best.result.score;
      item.econstatShared = best.result.econstatShared;
      item.criteria = best.result.criteria;
      item.level = levelForScore(best.result.score, this.thresholds);
    } else {
      item.declBId = undefined;
      item.refB = undefined;
      item.companyB = undefined;
      item.plateB = undefined;
      item.score = 0;
      item.econstatShared = false;
      item.criteria = { econstatPartage: false, plaquesCroisees: false, policeCroisee: false, dateHeure: false, compagniesCroisees: false, gps: false };
      item.level = 'NON';
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
    const pool = allExistingClaims.filter((c) => c.id !== newClaim.id);
    const { candidate } = await this.upsertRowForClaim(newClaim, pool);
    if (candidate) {
      const poolForCandidate = allExistingClaims.filter((c) => c.id !== candidate.id);
      await this.upsertRowForClaim(candidate, poolForCandidate);
    }
    this.realtime.emitEvent('match.updated', { claimId: newClaim.id, matchedWith: candidate?.id });
  }
}
