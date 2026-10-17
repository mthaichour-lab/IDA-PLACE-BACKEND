import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { resolveTenantFilter } from '../common/rbac/tenant-scope';
import { LedgerService } from '../ledger/ledger.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import { ContesterRecoursDto, CreateRecoursDto, ListRecoursQueryDto, OpposerRecoursDto, RecoursViewDto, SettleRecoursDto } from './dto/recours.dto';
import { Recours } from './entities/recours.entity';
import {
  applyRecoursTimers,
  computeContestationDeadline,
  computeSilenceDeadline,
  DEFAULT_RECOURS_TIMER_CONFIG,
  RecoursState,
  RecoursTimerConfig,
} from './recours.rules';

/** Repli mémoire — mode dégradé (voir README "Mode dégradé"). Persistant pour la durée du process. */
type MemoryRecours = RecoursViewDto;
const MEMORY_RECOURS: MemoryRecours[] = [];

function toView(r: Recours): RecoursViewDto {
  return {
    id: r.id,
    claimId: r.claimId,
    from: r.from,
    to: r.to,
    state: r.state,
    requestSentAt: r.requestSentAt.toISOString(),
    responseAt: r.responseAt?.toISOString(),
    opposition: r.opposition,
    contestation: r.contestation,
    commissionAt: r.commissionAt?.toISOString(),
    settledAt: r.settledAt?.toISOString(),
    amount: r.amount,
    currentDeadlineAt: r.currentDeadlineAt?.toISOString(),
  };
}

/**
 * RecoursModule — écran 4 "Échanges Annexes 2/3/4", B.2/B.3. Machine à
 * états + timers conventionnels (Art. 10/12/19) délégués aux fonctions
 * pures de `recours.rules.ts` ; ce service n'ajoute que la persistance
 * (`Recours`, repli mémoire en mode dégradé), le RBAC (B.7, scoping tenant —
 * §5 de la mission) et l'intégration transverse (`LedgerModule` pour la
 * traçabilité des transitions, `RealtimeModule` pour `recours.timer`).
 *
 * Scoping tenant (B.7) — hypothèse retenue : un `CORRESPONDANT_IDA`/
 * `TRESORIER` voit (et ne peut agir sur) que les recours où sa compagnie
 * est `from` OU `to` (il est partie à l'échange dans les deux sens) ; les
 * rôles "place" (dont `AUDITEUR_CSA`) voient tout.
 */
@Injectable()
export class RecoursService {
  private readonly memory: MemoryRecours[] = MEMORY_RECOURS;
  private readonly timerConfig: RecoursTimerConfig;

  constructor(
    @InjectRepository(Recours) private readonly repo: EntityRepository<Recours>,
    private readonly configService: ConfigService,
    private readonly realtime: RealtimeGateway,
    private readonly ledger: LedgerService,
  ) {
    this.timerConfig = {
      silenceDelayDays: Number(this.configService.get<string>('RECOURS_ART10_SILENCE_DAYS') ?? DEFAULT_RECOURS_TIMER_CONFIG.silenceDelayDays),
      contestationJustificationDays: Number(
        this.configService.get<string>('RECOURS_ART12_JUSTIFICATION_DAYS') ?? DEFAULT_RECOURS_TIMER_CONFIG.contestationJustificationDays,
      ),
      forclusionDays: Number(this.configService.get<string>('RECOURS_ART19_FORCLUSION_DAYS') ?? DEFAULT_RECOURS_TIMER_CONFIG.forclusionDays),
    };
  }

  getTimerConfig(): RecoursTimerConfig {
    return { ...this.timerConfig };
  }

  private visibleToUser(r: RecoursViewDto, user?: AuthenticatedUser): boolean {
    if (!user) return true;
    const tenant = resolveTenantFilter(user);
    if (!tenant) return true;
    return r.from === tenant || r.to === tenant;
  }

  private assertVisible(r: RecoursViewDto, user?: AuthenticatedUser): void {
    if (!this.visibleToUser(r, user)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
    }
  }

  /** Applique les timers conventionnels (Art. 10/12/19) à UNE ligne et persiste la transition si elle a eu lieu. */
  private async materializeTimers(r: Recours, now: Date): Promise<Recours> {
    const result = applyRecoursTimers(
      { state: r.state, requestSentAt: r.requestSentAt, currentDeadlineAt: r.currentDeadlineAt },
      now,
      this.timerConfig,
    );
    if (!result.transitioned) return r;

    r.state = result.state;
    r.currentDeadlineAt = result.currentDeadlineAt;
    if (result.commissionAt) r.commissionAt = result.commissionAt;
    await this.repo.getEntityManager().flush();
    await this.onAutoTransition(r, result.reason);
    return r;
  }

  private async materializeTimersMemory(r: MemoryRecours, now: Date): Promise<MemoryRecours> {
    const result = applyRecoursTimers(
      {
        state: r.state as RecoursState,
        requestSentAt: new Date(r.requestSentAt),
        currentDeadlineAt: r.currentDeadlineAt ? new Date(r.currentDeadlineAt) : undefined,
      },
      now,
      this.timerConfig,
    );
    if (!result.transitioned) return r;

    r.state = result.state;
    r.currentDeadlineAt = result.currentDeadlineAt?.toISOString();
    if (result.commissionAt) r.commissionAt = result.commissionAt.toISOString();
    await this.onAutoTransition(r, result.reason);
    return r;
  }

  private async onAutoTransition(r: { id: string; claimId: string; from: string; to: string; state: string }, reason?: string): Promise<void> {
    await this.ledger.append('RECOURS', r.id, 'system', `Transition automatique → ${r.state}${reason ? ` (${reason})` : ''}`);
    this.realtime.emitEvent('recours.timer', { id: r.id, claimId: r.claimId, state: r.state, reason }, `tenant:${r.from}`);
    this.realtime.emitEvent('recours.timer', { id: r.id, claimId: r.claimId, state: r.state, reason }, `tenant:${r.to}`);
  }

  private async findAll(): Promise<RecoursViewDto[]> {
    const now = new Date();
    return withDegradedFallback(
      'RecoursService.findAll',
      async () => {
        const rows = await this.repo.findAll({ orderBy: { requestSentAt: 'DESC' } });
        const materialized = await Promise.all(rows.map((r) => this.materializeTimers(r, now)));
        return materialized.map(toView);
      },
      async () => {
        const materialized = await Promise.all(this.memory.map((r) => this.materializeTimersMemory(r, now)));
        return [...materialized].sort((a, b) => (a.requestSentAt < b.requestSentAt ? 1 : -1)) as RecoursViewDto[];
      },
    );
  }

  async list(query: ListRecoursQueryDto, user?: AuthenticatedUser): Promise<PaginatedResult<RecoursViewDto>> {
    let rows = await this.findAll();
    rows = rows.filter((r) => this.visibleToUser(r, user));
    if (query.state) rows = rows.filter((r) => r.state === query.state);
    return paginateArray(rows, query.page, query.pageSize);
  }

  async get(id: string, user?: AuthenticatedUser): Promise<RecoursViewDto> {
    const rows = await this.findAll();
    const row = rows.find((r) => r.id === id);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recours introuvable.' });
    this.assertVisible(row, user);
    return row;
  }

  async create(dto: CreateRecoursDto): Promise<RecoursViewDto> {
    const requestSentAt = new Date();
    const currentDeadlineAt = computeSilenceDeadline(requestSentAt, this.timerConfig);

    const view = await withDegradedFallback(
      'RecoursService.create',
      async () => {
        const entity = this.repo.create({
          claimId: dto.claimId,
          from: dto.from,
          to: dto.to,
          amount: dto.amount,
          state: 'EN_ATTENTE',
          requestSentAt,
          currentDeadlineAt,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await this.repo.getEntityManager().persistAndFlush(entity);
        return toView(entity);
      },
      () => {
        const row: MemoryRecours = {
          id: randomUUID(),
          claimId: dto.claimId,
          from: dto.from,
          to: dto.to,
          amount: dto.amount,
          state: 'EN_ATTENTE',
          requestSentAt: requestSentAt.toISOString(),
          currentDeadlineAt: currentDeadlineAt.toISOString(),
        };
        this.memory.push(row);
        return row;
      },
    );

    await this.ledger.append('RECOURS', view.id, dto.from, `Recours envoyé (Annexe 2) vers ${dto.to} — dossier ${dto.claimId}`);
    this.realtime.emitEvent('recours.timer', { id: view.id, claimId: view.claimId, state: view.state }, `tenant:${dto.to}`);
    return view;
  }

  private async mutate(
    id: string,
    user: AuthenticatedUser | undefined,
    expectedState: RecoursState,
    sideOf: 'from' | 'to',
    applyEntity: (r: Recours) => void,
    applyMemory: (r: MemoryRecours) => void,
  ): Promise<RecoursViewDto> {
    return withDegradedFallback(
      'RecoursService.mutate',
      async () => {
        const entity = await this.repo.findOne({ id });
        if (!entity) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recours introuvable.' });
        this.assertSideAndVisibility(entity, user, sideOf);
        if (entity.state !== expectedState) {
          throw new ConflictException({
            code: 'CONFLICT',
            message: `Transition impossible depuis l'état ${entity.state} (attendu : ${expectedState}).`,
          });
        }
        applyEntity(entity);
        await this.repo.getEntityManager().flush();
        return toView(entity);
      },
      () => {
        const row = this.memory.find((r) => r.id === id);
        if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recours introuvable (mode dégradé).' });
        this.assertSideAndVisibility(row, user, sideOf);
        if (row.state !== expectedState) {
          throw new ConflictException({
            code: 'CONFLICT',
            message: `Transition impossible depuis l'état ${row.state} (attendu : ${expectedState}).`,
          });
        }
        applyMemory(row);
        return row;
      },
    );
  }

  private assertSideAndVisibility(r: { from: string; to: string }, user: AuthenticatedUser | undefined, sideOf: 'from' | 'to'): void {
    if (!user) return;
    const tenant = resolveTenantFilter(user);
    if (!tenant) return; // rôle "place" : accès complet
    if (r.from !== tenant && r.to !== tenant) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
    }
    if (r[sideOf] !== tenant) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: `Seule la compagnie "${sideOf}" de ce recours peut effectuer cette action.`,
      });
    }
  }

  /** Opposition (Art. 10/12) — formulée par la compagnie destinataire (`to`) avant l'échéance de silence. */
  async opposer(id: string, dto: OpposerRecoursDto, user: AuthenticatedUser): Promise<RecoursViewDto> {
    const now = new Date();
    const result = await this.mutate(
      id,
      user,
      'EN_ATTENTE',
      'to',
      (r) => {
        r.responseAt = now;
        r.opposition = { motif: dto.motif, at: now.toISOString(), by: user.name };
        r.state = 'OPPOSITION';
        r.currentDeadlineAt = undefined;
      },
      (r) => {
        r.responseAt = now.toISOString();
        r.opposition = { motif: dto.motif, at: now.toISOString(), by: user.name };
        r.state = 'OPPOSITION';
        r.currentDeadlineAt = undefined;
      },
    );
    await this.ledger.append('RECOURS', id, user.name, `Opposition formulée : ${dto.motif}`);
    this.realtime.emitEvent('recours.timer', { id, state: result.state }, `tenant:${result.from}`);
    return result;
  }

  /** Contestation de l'opposition (Art. 12) — formulée par la compagnie à l'origine du recours (`from`). */
  async contester(id: string, dto: ContesterRecoursDto, user: AuthenticatedUser): Promise<RecoursViewDto> {
    const now = new Date();
    const deadline = computeContestationDeadline(now, this.timerConfig);
    const result = await this.mutate(
      id,
      user,
      'OPPOSITION',
      'from',
      (r) => {
        r.contestation = { motif: dto.motif, at: now.toISOString(), by: user.name };
        r.state = 'CONTESTATION';
        r.currentDeadlineAt = deadline;
      },
      (r) => {
        r.contestation = { motif: dto.motif, at: now.toISOString(), by: user.name };
        r.state = 'CONTESTATION';
        r.currentDeadlineAt = deadline.toISOString();
      },
    );
    await this.ledger.append('RECOURS', id, user.name, `Contestation de l'opposition : ${dto.motif}`);
    this.realtime.emitEvent('recours.timer', { id, state: result.state }, `tenant:${result.to}`);
    return result;
  }

  /**
   * Règlement (accepté tacitement ou tranché en commission) — déclenché par
   * la compagnie débitrice (`to`, celle qui doit reverser le montant), avec
   * le privilège `pay` (`TRESORIER`). Toujours au montant du recours
   * (`Recours.amount`) : ni la compagnie créditrice ni la compagnie
   * débitrice ne peuvent fixer unilatéralement un autre montant depuis cet
   * endpoint (revue Product Owner, sprint 3 — un `dto.amount` librement
   * modifiable constituait un trou de contrôle financier). Restreint à la
   * compagnie `to` (et non simplement "être partie") pour la même raison :
   * c'est la débitrice qui atteste avoir payé, pas la créditrice qui
   * s'auto-déclare payée.
   */
  async settle(id: string, _dto: SettleRecoursDto, user: AuthenticatedUser): Promise<RecoursViewDto> {
    const now = new Date();
    const result = await withDegradedFallback(
      'RecoursService.settle',
      async () => {
        const entity = await this.repo.findOne({ id });
        if (!entity) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recours introuvable.' });
        this.assertSideAndVisibility(entity, user, 'to');
        if (entity.state !== 'ACCEPTE_TACITE' && entity.state !== 'COMMISSION') {
          throw new ConflictException({ code: 'CONFLICT', message: `Règlement impossible depuis l'état ${entity.state}.` });
        }
        entity.settledAt = now;
        entity.state = 'REGLE';
        await this.repo.getEntityManager().flush();
        return toView(entity);
      },
      () => {
        const row = this.memory.find((r) => r.id === id);
        if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recours introuvable (mode dégradé).' });
        this.assertSideAndVisibility(row, user, 'to');
        if (row.state !== 'ACCEPTE_TACITE' && row.state !== 'COMMISSION') {
          throw new ConflictException({ code: 'CONFLICT', message: `Règlement impossible depuis l'état ${row.state}.` });
        }
        row.settledAt = now.toISOString();
        row.state = 'REGLE';
        return row;
      },
    );
    await this.ledger.append('RECOURS', id, user.name, `Recours réglé (${result.amount} DA)`);
    return result;
  }
}
