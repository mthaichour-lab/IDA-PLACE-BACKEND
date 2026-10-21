import { LockMode, OptimisticLockError, RequestContext } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { MemoryBusinessRefCounter, nextBusinessRef } from '../common/business-ref/business-ref';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { assertCompanyAccess, resolveTenantFilter } from '../common/rbac/tenant-scope';
import { AdherentsService } from '../adherents/adherents.service';
import { DEFAULT_ELIGIBILITY_CONFIG } from '../eligibility/eligibility.rules';
import { LedgerService } from '../ledger/ledger.service';
import { PLACE_ROOM, RealtimeGateway, tenantRoom } from '../realtime/realtime.module';
import {
  CreateRecoursDto,
  ListRecoursQueryDto,
  RecoursTransitionDto,
  RecoursTransitionResultDto,
  RecoursViewDto,
} from './dto/recours.dto';
import { Recours } from './entities/recours.entity';
import { isValidMoney, MAX_TECHNICAL_AMOUNT_DA } from './money';
import { isPlaceUser } from './place-role';
import {
  applyAutomaticTransitions,
  applyManualTransition,
  computeTimerState,
  parseIntSetting,
  parseRecoursTimerConfig,
  RECOURS_ACTIONS,
  RecoursAction,
  RecoursHistoryEntry,
  RecoursSnapshot,
  RecoursState,
  RecoursTimerConfig,
  SYSTEM_ACTOR,
} from './recours.rules';
import { isUniqueViolation, toConflict, withStrictFallback } from './strict-persistence';

/** Repli mémoire — mode dégradé (hors production). Une ligne = base + snapshot (voir recours.rules.ts). */
type MemoryRecoursRow = RecoursSnapshot & {
  id: string;
  reference: string;
  claimId: string;
  from: string;
  to: string;
  amount: number;
  createdAt: string;
  history: RecoursHistoryEntry[];
  version: number;
};

/** Décision de commission rattachée à un recours (SEC-32) — fournie par `CommissionModule`, qui dépend de ce module (jamais l'inverse). */
export interface CommissionDecisionForRecours {
  caseId: string;
  status: string;
  outcome?: 'RECOURS_FONDE' | 'RECOURS_REJETE';
  pvRef?: string;
  pvSigned: boolean;
}

export type CommissionDecisionLookup = (recoursId: string) => Promise<CommissionDecisionForRecours | undefined>;

const NOT_FOUND = () => new NotFoundException({ code: 'NOT_FOUND', message: 'Recours introuvable.' });
const CONCURRENT = () => new ConflictException({ code: 'CONFLIT_CONCURRENT', message: 'Le recours a été modifié entre-temps : rechargez-le avant de recommencer.' });
const DUPLICATE = () => new ConflictException({ code: 'RECOURS_EXISTANT', message: 'Un recours existe déjà pour ce dossier.' });

function snapshotOf(e: Recours): RecoursSnapshot {
  return {
    state: e.state as RecoursState,
    requestSentAt: e.requestSentAt.toISOString(),
    responseAt: e.responseAt?.toISOString(),
    opposition: e.opposition,
    contestation: e.contestation,
    commissionAt: e.commissionAt?.toISOString(),
    settledAt: e.settledAt?.toISOString(),
    resolution: e.resolution,
  };
}

function applySnapshotToEntity(e: Recours, snap: RecoursSnapshot): void {
  e.state = snap.state;
  e.responseAt = snap.responseAt ? new Date(snap.responseAt) : e.responseAt;
  e.opposition = snap.opposition;
  e.contestation = snap.contestation;
  e.commissionAt = snap.commissionAt ? new Date(snap.commissionAt) : e.commissionAt;
  e.settledAt = snap.settledAt ? new Date(snap.settledAt) : e.settledAt;
  e.resolution = snap.resolution;
}

function baseOf(e: Recours) {
  return { id: e.id, reference: e.reference, claimId: e.claimId, from: e.from, to: e.to, amount: Number(e.amount), createdAt: e.createdAt.toISOString() };
}

function toView(base: { id: string; reference: string; claimId: string; from: string; to: string; amount: number; createdAt: string }, snap: RecoursSnapshot, now: Date, config: RecoursTimerConfig): RecoursViewDto {
  // SEC-17 : l'historique d'audit (identifiants des agents) et la version de
  // verrouillage ne sortent jamais dans la fiche — l'historique n'est servi
  // que par `GET /recours/:id/history`, réservé à la place. Les lignes du
  // repli mémoire portent ces champs : on les retire explicitement.
  const merged = { ...base, ...snap } as RecoursSnapshot & typeof base & { history?: unknown; version?: unknown };
  const { history: _history, version: _version, ...publicView } = merged;
  return { ...publicView, timer: computeTimerState(snap, now, config) };
}

/** Plafond conventionnel d'un recours (SEC-06) : le plafond Art. 4 déjà paramétré pour l'éligibilité — une seule source, jamais une 2e constante. */
function parseAmountCap(raw: string | undefined): number {
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_ELIGIBILITY_CONFIG.maxAmountDA;
  const text = String(raw).trim();
  const value = Number(text);
  if (!/^\d+(\.\d{1,2})?$/.test(text) || !Number.isFinite(value) || value <= 0 || value > MAX_TECHNICAL_AMOUNT_DA) {
    throw new Error(`Configuration invalide : ELIGIBILITY_MAX_AMOUNT_DA="${text}" (montant positif, 2 décimales au plus, ≤ ${MAX_TECHNICAL_AMOUNT_DA}).`);
  }
  return value;
}

/**
 * RecoursModule — B.2/B.3, écran 4 "Échanges Annexes 2/3/4". Machine d'état
 * + timers conventionnels (Art.10 silence, Art.12 opposition, Art.19
 * forclusion) en fonctions PURES et testées (`recours.rules.ts`) ; ce service
 * ajoute la persistance et l'orchestration.
 *
 * Revue sécurité 2026-10-19 :
 *  - SEC-06 : montant borné (plafond conventionnel, 2 décimales, fini) ;
 *  - SEC-07 : événements temps réel limités aux compagnies parties + place, payload `{ id, state }` ;
 *  - SEC-17 : chaque transition persiste auteur (`user.id`), rôle, compagnie représentée et motif, et est scellée au journal ;
 *  - SEC-20 : un seul recours par dossier (contrainte `UNIQUE` + 409) ;
 *  - SEC-32 : la clôture en commission exige une décision PRONONCÉE au PV signé ;
 *  - SEC-33 : transitions sous verrou (`SELECT … FOR UPDATE` + version) — deux transitions concurrentes : l'une reçoit 409 ;
 *  - SEC-35 : les transitions automatiques sont datées de leur échéance et appliquées aussi par une tâche périodique ;
 *  - SEC-46 : hors périmètre, réponse 404 identique à un recours inexistant, messages sans code de compagnie ;
 *  - SEC-48 : configuration des délais validée au démarrage.
 */
@Injectable()
export class RecoursService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RecoursService');
  /** Repli mémoire — mode dégradé (développement/test uniquement). */
  private readonly memory: MemoryRecoursRow[] = [];
  private readonly memoryRefs = new MemoryBusinessRefCounter();
  private readonly timerConfig: RecoursTimerConfig;
  private readonly amountCap: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer?: NodeJS.Timeout;
  private commissionLookup?: CommissionDecisionLookup;

  constructor(
    @InjectRepository(Recours) private readonly repo: EntityRepository<Recours>,
    private readonly configService: ConfigService,
    private readonly realtime: RealtimeGateway,
    // Optionnel : les specs d'autres modules instancient RecoursService sans référentiel ; un `reasonCode` exige alors sa présence.
    @Optional() private readonly adherents?: AdherentsService,
    // Toujours fourni par RecoursModule (LedgerModule importé) ; optionnel pour les specs d'autres modules.
    @Optional() private readonly ledger?: LedgerService,
  ) {
    const get = (key: string) => this.configService.get<string>(key);
    // SEC-48 : une valeur invalide fait échouer le démarrage (voir parseIntSetting).
    this.timerConfig = parseRecoursTimerConfig(get);
    this.amountCap = parseAmountCap(get('ELIGIBILITY_MAX_AMOUNT_DA'));
    this.sweepIntervalMs = parseIntSetting('RECOURS_SWEEP_INTERVAL_MINUTES', get('RECOURS_SWEEP_INTERVAL_MINUTES'), 60, 0, 1440) * 60_000;
  }

  getTimerConfig(): RecoursTimerConfig {
    return this.timerConfig;
  }

  getAmountCap(): number {
    return this.amountCap;
  }

  /** SEC-32 : `CommissionModule` fournit la décision de commission d'un recours (évite un cycle Recours → Commission). */
  registerCommissionDecisionLookup(lookup: CommissionDecisionLookup): void {
    this.commissionLookup = lookup;
  }

  /** SEC-35 : applique périodiquement les transitions automatiques, sans attendre qu'un écran soit consulté. */
  onModuleInit(): void {
    if (this.sweepIntervalMs <= 0) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err) => this.logger.error(`Balayage des échéances en échec : ${(err as Error).message}`));
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Applique les transitions automatiques échues (Art. 10/12/19) — appelé par la tâche périodique, hors requête HTTP. */
  async sweep(now = new Date()): Promise<void> {
    await RequestContext.create(this.repo.getEntityManager(), () => this.computeAllViews(now));
  }

  private emitState(id: string, reference: string, state: string, from: string, to: string, internal?: Record<string, unknown>): void {
    // SEC-07 : payload WebSocket minimal (aucun nom, aucun auteur), diffusé aux seules parties + place ; la référence métier n'est qu'un libellé de l'id.
    this.realtime.emitEvent('recours.timer', { id, reference, state }, { rooms: [PLACE_ROOM, tenantRoom(from), tenantRoom(to)], internalPayload: { id, reference, state, from, to, ...internal } });
  }

  private async seal(type: string, id: string, actorId: string, summary: Record<string, unknown>): Promise<void> {
    if (!this.ledger) return;
    await this.ledger.append(type, id, actorId, JSON.stringify(summary));
  }

  private automaticEntry(before: RecoursSnapshot, after: RecoursSnapshot): RecoursHistoryEntry {
    return {
      at: after.resolution?.at ?? new Date().toISOString(),
      action: 'automatique',
      fromState: before.state,
      toState: after.state,
      ...SYSTEM_ACTOR,
      resolutionKind: after.resolution?.kind,
    };
  }

  /**
   * Charge tous les recours, applique les transitions automatiques échues et
   * persiste celles qui ont effectivement changé l'état (verrou optimiste :
   * une transition concurrente gagne, la lecture se contente de recharger).
   */
  private async computeAllViews(now: Date): Promise<RecoursViewDto[]> {
    return withDegradedFallback(
      'RecoursService.computeAllViews',
      async () => {
        // Contexte dédié : aucune entité « recours » ne reste gérée (et potentiellement périmée) dans l'EntityManager de la requête.
        const em = this.freshEm();
        const rows = await em.find(Recours, {}, { orderBy: { requestSentAt: 'DESC' } });
        const views: RecoursViewDto[] = [];
        for (const e of rows) {
          const current = snapshotOf(e);
          const { changed, snapshot } = applyAutomaticTransitions(current, now, this.timerConfig);
          let effective = snapshot;
          if (changed) effective = await this.persistAutomatic(em, e, current, snapshot);
          views.push(toView(baseOf(e), effective, now, this.timerConfig));
        }
        return views;
      },
      async () => {
        const views: RecoursViewDto[] = [];
        for (const row of this.memory) {
          const before: RecoursSnapshot = { ...row };
          const { changed, snapshot } = applyAutomaticTransitions(before, now, this.timerConfig);
          if (changed) {
            Object.assign(row, snapshot);
            row.version += 1;
            row.history.push(this.automaticEntry(before, snapshot));
            this.emitState(row.id, row.reference, snapshot.state, row.from, row.to, { resolution: snapshot.resolution });
            await this.seal('RECOURS_TRANSITION', row.id, SYSTEM_ACTOR.actorId, { action: 'automatique', from: before.state, to: snapshot.state, resolution: snapshot.resolution?.kind, at: snapshot.resolution?.at });
          }
          views.push(toView(row, snapshot, now, this.timerConfig));
        }
        return views.sort((a, b) => (a.requestSentAt < b.requestSentAt ? 1 : -1));
      },
    );
  }

  /** EntityManager isolé (identité vierge) : chaque lecture/écriture de recours part de l'état réel de la base. */
  private freshEm(): EntityManager {
    return (this.repo.getEntityManager() as EntityManager).fork({ clear: true });
  }

  private async persistAutomatic(em: EntityManager, e: Recours, before: RecoursSnapshot, after: RecoursSnapshot): Promise<RecoursSnapshot> {
    const seenVersion = e.version;
    try {
      await em.transactional(async (tem) => {
        // SEC-33 : verrou + relecture ; si l'état a changé depuis la lecture, une transition concurrente a gagné.
        const locked = await tem.findOne(Recours, { id: e.id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
        if (!locked || locked.version !== seenVersion) throw new OptimisticLockError(`Recours ${e.id} modifié entre-temps`);
        applySnapshotToEntity(locked, after);
        locked.history = [...(locked.history ?? []), this.automaticEntry(before, after)];
        await tem.flush();
        await this.seal('RECOURS_TRANSITION', e.id, SYSTEM_ACTOR.actorId, { action: 'automatique', from: before.state, to: after.state, resolution: after.resolution?.kind, at: after.resolution?.at });
      });
    } catch (err) {
      if (!(err instanceof OptimisticLockError)) throw err;
      // Une transition concurrente a gagné : on affiche l'état réel, sans rien écraser.
      const fresh = await this.freshEm().findOne(Recours, { id: e.id });
      return fresh ? snapshotOf(fresh) : before;
    }
    this.emitState(e.id, e.reference, after.state, e.from, e.to, { resolution: after.resolution });
    return after;
  }

  /** B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que les recours où sa compagnie est `from` ou `to` ; les rôles "place" voient tout. */
  private visibleToUser(r: { from: string; to: string }, user?: AuthenticatedUser): boolean {
    if (!user) return true;
    const tenant = resolveTenantFilter(user);
    if (!tenant) return true;
    return r.from === tenant || r.to === tenant;
  }

  async list(query: ListRecoursQueryDto, user?: AuthenticatedUser): Promise<PaginatedResult<RecoursViewDto>> {
    let rows = await this.computeAllViews(new Date());
    rows = rows.filter((r) => this.visibleToUser(r, user));
    if (query.filter && query.filter !== 'TOUS') rows = rows.filter((r) => r.state === query.filter);
    if (query.q) {
      const needle = query.q.trim().toLowerCase();
      if (needle) rows = rows.filter((r) => [r.id, r.reference, r.claimId, r.from, r.to].some((v) => v.toLowerCase().includes(needle)));
    }
    return paginateArray(rows, query.page, query.pageSize);
  }

  /** Interface publique pour les autres modules (SettlementModule, CommissionModule) — jamais l'entité MikroORM. Usage interne, jamais exposé directement à un utilisateur : pas de scoping tenant ici (les modules appelants agrègent toute la place). */
  async listAll(): Promise<RecoursViewDto[]> {
    return this.computeAllViews(new Date());
  }

  async counters(user?: AuthenticatedUser): Promise<Record<string, number>> {
    const rows = (await this.computeAllViews(new Date())).filter((r) => this.visibleToUser(r, user));
    const counters: Record<string, number> = { TOUS: rows.length };
    for (const state of ['EN_ATTENTE', 'OPPOSITION', 'CONTESTATION', 'COMMISSION', 'REGLE', 'REJETE', 'FORCLOS']) {
      counters[state] = rows.filter((r) => r.state === state).length;
    }
    return counters;
  }

  /**
   * Interface inter-modules historique (DocumentsModule…) : 404 si inexistant,
   * 403 si hors périmètre. Les routes de ce module utilisent `getForUser`
   * (404 uniforme, SEC-46).
   */
  async get(id: string, user?: AuthenticatedUser): Promise<RecoursViewDto> {
    const rows = await this.computeAllViews(new Date());
    const row = rows.find((r) => r.id === id);
    if (!row) throw NOT_FOUND();
    if (!this.visibleToUser(row, user)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
    return row;
  }

  /** SEC-46 — hors périmètre, la réponse est identique à celle d'un recours inexistant (404 générique). */
  async getForUser(id: string, user: AuthenticatedUser): Promise<RecoursViewDto> {
    const row = (await this.computeAllViews(new Date())).find((r) => r.id === id);
    if (!row || !this.visibleToUser(row, user)) throw NOT_FOUND();
    return row;
  }

  /** SEC-17 — historique des transitions (auteurs, rôles, motifs) : réservé aux rôles place (audit), 404 sinon. */
  async history(id: string, user: AuthenticatedUser): Promise<RecoursHistoryEntry[]> {
    if (!isPlaceUser(user)) throw NOT_FOUND();
    return withDegradedFallback(
      'RecoursService.history',
      async () => {
        const e = await this.freshEm().findOne(Recours, { id });
        if (!e) throw NOT_FOUND();
        return e.history ?? [];
      },
      () => {
        const row = this.memory.find((r) => r.id === id);
        if (!row) throw NOT_FOUND();
        return [...row.history];
      },
    );
  }

  /**
   * Revue sécurité 2026-10-18 (B.7) : `dto.from` doit être la compagnie de l'appelant (sauf rôle place).
   * SEC-06 : montant fini, > 0, deux décimales, ≤ plafond conventionnel (le rapprochement avec le montant du
   * dossier est fait par `ClaimsService.openRecours`, seul à connaître le dossier).
   * SEC-20 : un seul recours par dossier — contrainte `UNIQUE(claim_id)` en base, 409 `RECOURS_EXISTANT`.
   */
  async create(dto: CreateRecoursDto, user?: AuthenticatedUser): Promise<RecoursViewDto> {
    if (user) assertCompanyAccess(user, dto.from);
    if (!isValidMoney(dto.amount)) {
      throw new BadRequestException({ code: 'MONTANT_INVALIDE', message: 'Montant invalide : nombre fini, strictement positif, deux décimales au plus.' });
    }
    if (dto.amount > this.amountCap) {
      throw new BadRequestException({ code: 'RECOURS_MONTANT_PLAFOND', message: `Montant supérieur au plafond conventionnel (${this.amountCap} DA).` });
    }
    if (dto.from === dto.to) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'La compagnie adverse doit être différente de la compagnie demanderesse.' });
    }
    const now = new Date();
    const actor = user ? { actorId: user.id, actorRole: user.role, ...(user.companyId ? { onBehalfOf: user.companyId } : {}) } : SYSTEM_ACTOR;
    const creation: RecoursHistoryEntry = { at: now.toISOString(), action: 'creation', toState: 'EN_ATTENTE', ...actor };
    const sealSummary = { action: 'creation', claimId: dto.claimId, from: dto.from, to: dto.to, amount: dto.amount, role: actor.actorRole };

    const view = await withStrictFallback(
      'RecoursService.create',
      async () => {
        try {
          return await this.freshEm().transactional(async (tem) => {
            if (await tem.findOne(Recours, { claimId: dto.claimId })) throw DUPLICATE();
            const entity = tem.create(Recours, {
              // Attribuée dans la transaction : un échec de création ne consomme pas de numéro.
              reference: await nextBusinessRef(tem, 'REC', now),
              claimId: dto.claimId,
              from: dto.from,
              to: dto.to,
              amount: dto.amount,
              state: 'EN_ATTENTE',
              requestSentAt: now,
              history: [creation],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);
            await tem.flush();
            await this.seal('RECOURS_OUVERT', entity.id, actor.actorId, sealSummary);
            return toView(baseOf(entity), snapshotOf(entity), now, this.timerConfig);
          });
        } catch (err) {
          throw isUniqueViolation(err) ? DUPLICATE() : err;
        }
      },
      async () => {
        // Section synchrone : vérification + insertion atomiques dans le process (mode dégradé).
        if (this.memory.some((r) => r.claimId === dto.claimId)) throw DUPLICATE();
        const row: MemoryRecoursRow = {
          id: randomUUID(),
          reference: this.memoryRefs.next('REC', now),
          claimId: dto.claimId,
          from: dto.from,
          to: dto.to,
          amount: dto.amount,
          state: 'EN_ATTENTE',
          requestSentAt: now.toISOString(),
          createdAt: now.toISOString(),
          history: [creation],
          version: 1,
        };
        this.memory.push(row);
        await this.seal('RECOURS_OUVERT', row.id, actor.actorId, sealSummary);
        return toView(row, row, now, this.timerConfig);
      },
    );
    // Notification de la compagnie débitrice (et de la place) — SEC-06 §4 / SEC-07.
    this.emitState(view.id, view.reference, view.state, view.from, view.to, { created: true });
    return view;
  }

  /**
   * Autorisation par action, APRÈS le contrôle de visibilité (SEC-46 : un non-participant a déjà reçu un 404) :
   *  - accepter/opposer : réaction de la compagnie adverse (`to`) ;
   *  - lever_opposition/contester : réaction de la compagnie demanderesse (`from`) — règle de `lever_opposition` en attente de confirmation UAR (SEC-18, QUESTIONS_UAR.md §15) ;
   *  - SEC-17 : ces quatre actes engagent une compagnie : un rôle place ne peut pas les accomplir à sa place (403) ;
   *  - transmettre_commission : l'une des deux parties ou un rôle place ;
   *  - cloturer_commission_* : rôle place uniquement (SEC-25 : jamais un utilisateur rattaché à une compagnie).
   * Messages génériques : jamais le code d'une compagnie (SEC-46).
   */
  private assertActionAllowed(action: RecoursAction, from: string, to: string, user: AuthenticatedUser): void {
    const place = isPlaceUser(user);
    const tenant = place ? undefined : resolveTenantFilter(user);
    const forbidden = (message: string) => new ForbiddenException({ code: 'FORBIDDEN', message });
    switch (action) {
      case 'cloturer_commission_favorable':
      case 'cloturer_commission_defavorable':
        if (!place) throw forbidden('Seule la commission (rôle place) peut clôturer un dossier transmis en commission.');
        return;
      case 'accepter':
      case 'opposer':
        if (place) throw forbidden('Cet acte engage la compagnie destinataire : il ne peut pas être accompli par un rôle de la place.');
        if (tenant !== to) throw forbidden('Seule la compagnie destinataire du recours peut effectuer cette action.');
        return;
      case 'lever_opposition':
      case 'contester':
        if (place) throw forbidden('Cet acte engage la compagnie demanderesse : il ne peut pas être accompli par un rôle de la place.');
        if (tenant !== from) throw forbidden('Seule la compagnie demanderesse du recours peut effectuer cette action.');
        return;
      case 'transmettre_commission':
        if (!place && tenant !== from && tenant !== to) throw forbidden('Action réservée aux parties au recours.');
        return;
    }
  }

  /** SEC-32 : la clôture en commission découle d'une décision PRONONCÉE, au PV signé, de sens identique. */
  private async commissionBasis(id: string, action: RecoursAction): Promise<{ commissionCaseId?: string; pvRef?: string }> {
    if (action !== 'cloturer_commission_favorable' && action !== 'cloturer_commission_defavorable') return {};
    const decision = this.commissionLookup ? await this.commissionLookup(id) : undefined;
    const expected = action === 'cloturer_commission_favorable' ? 'RECOURS_FONDE' : 'RECOURS_REJETE';
    if (!decision || decision.status !== 'PRONONCE' || !decision.pvSigned || decision.outcome !== expected) {
      throw new ConflictException({
        code: 'DECISION_COMMISSION_REQUISE',
        message: `La clôture exige une décision de commission prononcée (${expected}) dont le PV est signé.`,
      });
    }
    return { commissionCaseId: decision.caseId, pvRef: decision.pvRef };
  }

  async transition(id: string, dto: RecoursTransitionDto, user: AuthenticatedUser): Promise<RecoursTransitionResultDto> {
    if (!(RECOURS_ACTIONS as readonly string[]).includes(dto.action)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: `Action inconnue: ${dto.action}` });
    }
    const action = dto.action as RecoursAction;
    if (dto.reasonCode !== undefined && action !== 'opposer') {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: '"reasonCode" n’est accepté que pour l’action "opposer".' });
    }
    const now = new Date();

    /** Contrôles communes aux deux voies (base / mémoire), puis calcul de l'état cible. */
    const decide = async (from: string, to: string, current: RecoursSnapshot) => {
      if (!this.visibleToUser({ from, to }, user)) throw NOT_FOUND();
      if (dto.reasonCode !== undefined) {
        if (!this.adherents) throw new Error('Référentiel des motifs d’opposition indisponible (AdherentsService non injecté).');
        await this.adherents.assertOppositionMotifUsable(dto.reasonCode);
      }
      this.assertActionAllowed(action, from, to, user);
      // Évalue d'abord les transitions automatiques (le timer peut avoir expiré entre deux requêtes).
      const { snapshot: autoSnapshot } = applyAutomaticTransitions(current, now, this.timerConfig);
      const next = applyManualTransition(autoSnapshot, action, now, this.timerConfig, { reason: dto.reason, reasonCode: dto.reasonCode });
      if (!next) {
        throw new BadRequestException({ code: 'INVALID_TRANSITION', message: `Action "${action}" non autorisée depuis l'état "${autoSnapshot.state}".` });
      }
      const basis = await this.commissionBasis(id, action);
      if (basis.commissionCaseId && next.resolution) next.resolution = { ...next.resolution, note: [dto.reason, `Dossier ${basis.commissionCaseId}`, basis.pvRef && `PV ${basis.pvRef}`].filter(Boolean).join(' — ') };
      const place = isPlaceUser(user);
      const entry: RecoursHistoryEntry = {
        at: now.toISOString(),
        action,
        fromState: autoSnapshot.state,
        toState: next.state,
        actorId: user.id,
        actorRole: user.role,
        ...(!place && user.companyId ? { onBehalfOf: user.companyId } : {}),
        ...(dto.reason ? { reason: dto.reason } : {}),
        ...basis,
      };
      const autoEntry = autoSnapshot.state !== current.state ? this.automaticEntry(current, autoSnapshot) : undefined;
      return { next, entries: autoEntry ? [autoEntry, entry] : [entry] };
    };
    const sealOf = (from: string, to: string, entries: RecoursHistoryEntry[]) =>
      this.seal('RECOURS_TRANSITION', id, user.id, { action, entries: entries.map(({ action: a, fromState, toState, actorRole, onBehalfOf, commissionCaseId, pvRef }) => ({ a, fromState, toState, actorRole, onBehalfOf, commissionCaseId, pvRef })), from, to });

    const result = await withStrictFallback(
      'RecoursService.transition',
      async () => {
        try {
          return await this.freshEm().transactional(async (tem) => {
            // SEC-33 : verrou pessimiste dans la transaction + colonne de version.
            const e = await tem.findOne(Recours, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
            if (!e) throw NOT_FOUND();
            const { next, entries } = await decide(e.from, e.to, snapshotOf(e));
            applySnapshotToEntity(e, next);
            e.history = [...(e.history ?? []), ...entries];
            await tem.flush();
            await sealOf(e.from, e.to, entries);
            return { next, reference: e.reference, from: e.from, to: e.to };
          });
        } catch (err) {
          throw toConflict(err, 'CONFLIT_CONCURRENT', 'Le recours a été modifié entre-temps : rechargez-le avant de recommencer.');
        }
      },
      async () => {
        const row = this.memory.find((r) => r.id === id);
        if (!row) throw NOT_FOUND();
        const version = row.version;
        const { next, entries } = await decide(row.from, row.to, { ...row });
        // SEC-33 (mode dégradé) : comparer-et-écrire synchrone sur la version lue.
        if (row.version !== version) throw CONCURRENT();
        Object.assign(row, next);
        row.version += 1;
        row.history.push(...entries);
        await sealOf(row.from, row.to, entries);
        return { next, reference: row.reference, from: row.from, to: row.to };
      },
    );

    this.emitState(id, result.reference, result.next.state, result.from, result.to, { action });
    return {
      id,
      state: result.next.state,
      timer: computeTimerState(result.next, now, this.timerConfig),
      transitionedAt: now.toISOString(),
    };
  }
}
