import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { logDegraded, withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { assertCompanyAccess, resolveTenantFilter } from '../common/rbac/tenant-scope';
import { RealtimeGateway } from '../realtime/realtime.module';
import {
  CreateRecoursDto,
  ListRecoursQueryDto,
  RecoursTransitionDto,
  RecoursTransitionResultDto,
  RecoursViewDto,
} from './dto/recours.dto';
import { Recours } from './entities/recours.entity';
import {
  applyAutomaticTransitions,
  applyManualTransition,
  computeTimerState,
  DEFAULT_RECOURS_TIMER_CONFIG,
  RECOURS_ACTIONS,
  RecoursAction,
  RecoursSnapshot,
  RecoursState,
  RecoursTimerConfig,
} from './recours.rules';

/** Repli mémoire — mode dégradé. Une ligne = base + snapshot (voir recours.rules.ts). */
type MemoryRecoursRow = RecoursSnapshot & {
  id: string;
  claimId: string;
  from: string;
  to: string;
  amount: number;
  createdAt: string;
};

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

function toView(base: { id: string; claimId: string; from: string; to: string; amount: number; createdAt: string }, snap: RecoursSnapshot, now: Date, config: RecoursTimerConfig): RecoursViewDto {
  return { ...base, ...snap, timer: computeTimerState(snap, now, config) };
}

/**
 * RecoursModule — B.2/B.3, écran 4 "Échanges Annexes 2/3/4". Machine d'état
 * + timers conventionnels (Art.10 silence, Art.12 opposition, Art.19
 * forclusion) en fonctions PURES et testées (`recours.rules.ts`,
 * `recours.rules.spec.ts`) ; ce service n'ajoute que la persistance
 * (`Recours`, repli mémoire en mode dégradé) et l'orchestration : évaluation
 * PARESSEUSE des transitions automatiques (silence/opposition/forclusion) à
 * chaque lecture/écriture, faute d'ordonnanceur dédié dans ce sprint (voir
 * HANDOFF.md).
 *
 * Contrat stable : `GET /recours?filter&page` et `POST /recours/{id}/transition`
 * (B.11) conservent leurs routes ; la forme du corps/réponse, auparavant un
 * mock libre, est désormais la forme réelle documentée ci-dessus.
 */
@Injectable()
export class RecoursService {
  /** Repli mémoire — mode dégradé. Persistant pour la durée du process (voir README "Mode dégradé"). */
  private readonly memory: MemoryRecoursRow[] = [];
  private readonly timerConfig: RecoursTimerConfig;

  constructor(
    @InjectRepository(Recours) private readonly repo: EntityRepository<Recours>,
    private readonly configService: ConfigService,
    private readonly realtime: RealtimeGateway,
  ) {
    // Art.10/Art.12 : hypothèses documentées (dossier technique silencieux
    // sur la durée exacte), paramétrables. Art.19 : réutilise la MÊME
    // variable d'environnement que EligibilityModule (cohérence demandée
    // par la mission), plutôt qu'une variable dupliquée.
    this.timerConfig = {
      silenceDays: Number(this.configService.get<string>('RECOURS_SILENCE_DAYS') ?? DEFAULT_RECOURS_TIMER_CONFIG.silenceDays),
      oppositionDays: Number(this.configService.get<string>('RECOURS_OPPOSITION_DAYS') ?? DEFAULT_RECOURS_TIMER_CONFIG.oppositionDays),
      forclusionMonths: Number(
        this.configService.get<string>('ELIGIBILITY_RECOURS_MAX_MONTHS') ?? DEFAULT_RECOURS_TIMER_CONFIG.forclusionMonths,
      ),
    };
  }

  getTimerConfig(): RecoursTimerConfig {
    return this.timerConfig;
  }

  /**
   * Charge tous les recours, applique paresseusement les transitions
   * automatiques (Art.10/12/19) et persiste celles qui ont effectivement
   * changé l'état — émet `recours.timer` (B.12) pour chacune.
   */
  private async computeAllViews(now: Date): Promise<RecoursViewDto[]> {
    return withDegradedFallback(
      'RecoursService.computeAllViews',
      async () => {
        const rows = await this.repo.findAll({ orderBy: { requestSentAt: 'DESC' } });
        const views: RecoursViewDto[] = [];
        for (const e of rows) {
          const current = snapshotOf(e);
          const { changed, snapshot } = applyAutomaticTransitions(current, now, this.timerConfig);
          if (changed) {
            applySnapshotToEntity(e, snapshot);
            await this.repo.getEntityManager().flush();
            this.realtime.emitEvent('recours.timer', { id: e.id, state: snapshot.state, resolution: snapshot.resolution });
          }
          views.push(toView({ id: e.id, claimId: e.claimId, from: e.from, to: e.to, amount: e.amount, createdAt: e.createdAt.toISOString() }, snapshot, now, this.timerConfig));
        }
        return views;
      },
      () => {
        const views: RecoursViewDto[] = [];
        for (const row of this.memory) {
          const { changed, snapshot } = applyAutomaticTransitions(row, now, this.timerConfig);
          if (changed) {
            Object.assign(row, snapshot);
            this.realtime.emitEvent('recours.timer', { id: row.id, state: snapshot.state, resolution: snapshot.resolution });
          }
          views.push(toView(row, snapshot, now, this.timerConfig));
        }
        return views.sort((a, b) => (a.requestSentAt < b.requestSentAt ? 1 : -1));
      },
    );
  }

  /** B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que les recours où sa compagnie est `from` ou `to` ; les rôles "place" voient tout. Comblé en revue Product Owner, sprint 3 — absent jusqu'ici. */
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
      if (needle) rows = rows.filter((r) => [r.id, r.claimId, r.from, r.to].some((v) => v.toLowerCase().includes(needle)));
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

  async get(id: string, user?: AuthenticatedUser): Promise<RecoursViewDto> {
    const rows = await this.computeAllViews(new Date());
    const row = rows.find((r) => r.id === id);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recours introuvable.' });
    if (!this.visibleToUser(row, user)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
    return row;
  }

  /** Revue sécurité 2026-10-18 (B.7) : `assertCompanyAccess` ajouté — avant, `dto.from` venait du corps sans vérification, un `CORRESPONDANT_IDA` pouvait créer un recours au nom d'une AUTRE compagnie (`from`). */
  async create(dto: CreateRecoursDto, user?: AuthenticatedUser): Promise<RecoursViewDto> {
    if (user) assertCompanyAccess(user, dto.from);
    const now = new Date();
    return withDegradedFallback(
      'RecoursService.create',
      async () => {
        const entity = this.repo.create({
          claimId: dto.claimId,
          from: dto.from,
          to: dto.to,
          amount: dto.amount,
          state: 'EN_ATTENTE',
          requestSentAt: now,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await this.repo.getEntityManager().persistAndFlush(entity);
        const snap = snapshotOf(entity);
        return toView({ id: entity.id, claimId: entity.claimId, from: entity.from, to: entity.to, amount: entity.amount, createdAt: entity.createdAt.toISOString() }, snap, now, this.timerConfig);
      },
      () => {
        const row: MemoryRecoursRow = {
          id: randomUUID(),
          claimId: dto.claimId,
          from: dto.from,
          to: dto.to,
          amount: dto.amount,
          state: 'EN_ATTENTE',
          requestSentAt: now.toISOString(),
          createdAt: now.toISOString(),
        };
        this.memory.push(row);
        return toView(row, row, now, this.timerConfig);
      },
    );
  }

  /**
   * Récupère la ligne (DB ou repli mémoire) SANS passer par
   * `withDegradedFallback` : contrairement aux lectures en masse
   * (`computeAllViews`), cette méthode doit ensuite lever des exceptions
   * MÉTIER (404/400) qu'il ne faut jamais confondre avec une bascule en
   * mode dégradé (`withDegradedFallback` catcherait aussi ces exceptions et
   * retomberait, à tort, sur le repli mémoire — masquant par exemple un
   * 400 "action invalide" derrière un 404 "introuvable (mode dégradé)").
   */
  private async loadForTransition(id: string): Promise<{ mode: 'db'; entity: Recours } | { mode: 'memory'; row: MemoryRecoursRow }> {
    try {
      const entity = await this.repo.findOne({ id });
      if (entity) return { mode: 'db', entity };
    } catch (err) {
      logDegraded('RecoursService.transition', `base de données injoignable (${(err as Error).message}) — repli mémoire`);
    }
    const row = this.memory.find((r) => r.id === id);
    if (row) return { mode: 'memory', row };
    throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recours introuvable.' });
  }

  /**
   * Autorisation par action — absente jusqu'ici (trouvé en revue Product
   * Owner, sprint 3 : seul le `@Privileges('exchange','decide')` du
   * contrôleur filtrait, n'importe quel `CORRESPONDANT_IDA`/`TRESORIER`
   * pouvait agir sur n'importe quel recours, y compris clôturer une
   * commission à la place des membres de la commission).
   *  - accepter/opposer : réaction de la compagnie adverse (`to`).
   *  - lever_opposition/contester : réaction de la compagnie demanderesse (`from`).
   *  - transmettre_commission : escalade, les deux parties ou un rôle "place".
   *  - cloturer_commission_* : décision de la commission — rôle "place" uniquement.
   */
  private assertActionAllowed(action: RecoursAction, from: string, to: string, user: AuthenticatedUser): void {
    const tenant = resolveTenantFilter(user);
    if (!tenant) return; // rôle "place" : toujours autorisé
    if (action === 'cloturer_commission_favorable' || action === 'cloturer_commission_defavorable') {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Seule la commission (rôle "place") peut clôturer un dossier transmis en commission.' });
    }
    if (action === 'accepter' || action === 'opposer') {
      if (tenant !== to) throw new ForbiddenException({ code: 'FORBIDDEN', message: `Seule la compagnie destinataire ("${to}") peut effectuer cette action.` });
      return;
    }
    if (action === 'lever_opposition' || action === 'contester') {
      if (tenant !== from) throw new ForbiddenException({ code: 'FORBIDDEN', message: `Seule la compagnie demanderesse ("${from}") peut effectuer cette action.` });
      return;
    }
    // transmettre_commission : les deux parties.
    if (tenant !== from && tenant !== to) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
    }
  }

  async transition(id: string, dto: RecoursTransitionDto, user: AuthenticatedUser): Promise<RecoursTransitionResultDto> {
    if (!(RECOURS_ACTIONS as readonly string[]).includes(dto.action)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: `Action inconnue: ${dto.action}` });
    }
    const action = dto.action as RecoursAction;
    const decidedBy = user.name;
    const now = new Date();

    const loaded = await this.loadForTransition(id);
    const currentFromTo = loaded.mode === 'db' ? { from: loaded.entity.from, to: loaded.entity.to } : { from: loaded.row.from, to: loaded.row.to };
    this.assertActionAllowed(action, currentFromTo.from, currentFromTo.to, user);
    const currentSnapshot = loaded.mode === 'db' ? snapshotOf(loaded.entity) : { ...loaded.row };

    // Évalue d'abord les transitions automatiques (le timer peut avoir
    // expiré entre deux requêtes) avant de tenter l'action manuelle.
    const { snapshot: autoSnapshot } = applyAutomaticTransitions(currentSnapshot, now, this.timerConfig);
    const next = applyManualTransition(autoSnapshot, action, now, this.timerConfig, { reason: dto.reason });
    if (!next) {
      throw new BadRequestException({
        code: 'INVALID_TRANSITION',
        message: `Action "${action}" non autorisée depuis l'état "${autoSnapshot.state}".`,
      });
    }

    if (loaded.mode === 'db') {
      applySnapshotToEntity(loaded.entity, next);
      await this.repo.getEntityManager().flush();
    } else {
      Object.assign(loaded.row, next);
    }

    this.realtime.emitEvent('recours.timer', { id, state: next.state, decidedBy });

    return {
      id,
      state: next.state,
      timer: computeTimerState(next, now, this.timerConfig),
      transitionedAt: now.toISOString(),
    };
  }
}
