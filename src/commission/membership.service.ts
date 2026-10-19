import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AdherentsService } from '../adherents/adherents.service';
import { CLOCK, Clock, systemClock } from '../common/clock';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { logDegraded, withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { resolveTenantFilter } from '../common/rbac/tenant-scope';
import {
  AcceptMembershipRequestDto,
  CreateMembershipRequestDto,
  ListMembershipRequestsQueryDto,
  MembershipRequestViewDto,
  RejectMembershipRequestDto,
} from './dto/membership.dto';
import { MembershipRequest } from './entities/membership-request.entity';
import {
  computeWithdrawalEffectiveDate,
  isIsoCalendarDate,
  isWithdrawalEffectiveReached,
  MembershipAction,
  MembershipState,
  MembershipType,
  nextMembershipState,
} from './membership.rules';

type MemoryMembership = MembershipRequestViewDto;

type Loaded = { mode: 'db'; entity: MembershipRequest } | { mode: 'memory'; row: MemoryMembership };

type DecisionPatch = Required<Pick<MemoryMembership, 'state' | 'decidedAt' | 'decidedBy'>> &
  Partial<Pick<MemoryMembership, 'decisionNote' | 'agrementRef' | 'companyId' | 'companyCode'>>;

function toView(e: MembershipRequest): MembershipRequestViewDto {
  return {
    id: e.id,
    type: e.type,
    state: e.state,
    companyId: e.companyId,
    companyCode: e.companyCode,
    candidateName: e.candidateName,
    agrementRef: e.agrementRef,
    receivedAt: e.receivedAt,
    effectiveDate: e.effectiveDate,
    decidedAt: e.decidedAt?.toISOString(),
    decidedBy: e.decidedBy,
    decisionNote: e.decisionNote,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
  };
}

/**
 * Adhésions et retraits (Chapitre VI, Art. 30-35) — onglet de l'écran 7
 * "Commission". Dépend d'`AdherentsModule` (interface publique
 * `AdherentsService`) pour vérifier l'existence d'une compagnie et constater
 * un retrait ; l'acceptation d'une adhésion ne crée jamais la compagnie
 * (c'est `POST /referential/companies`, privilège `onboardCompany`).
 *
 * Les contrôles d'autorisation et de transition sont faits AVANT toute
 * persistance, jamais dans une closure de `withDegradedFallback`.
 */
@Injectable()
export class MembershipService {
  private readonly memory: MemoryMembership[] = [];
  private readonly now: Clock;

  constructor(
    @InjectRepository(MembershipRequest) private readonly repo: EntityRepository<MembershipRequest>,
    private readonly adherents: AdherentsService,
    @Optional() @Inject(CLOCK) clock?: Clock,
  ) {
    this.now = clock ?? systemClock;
  }

  private async loadAll(): Promise<MembershipRequestViewDto[]> {
    const rows = await withDegradedFallback(
      'MembershipService.loadAll',
      async () => (await this.repo.findAll({ orderBy: { createdAt: 'DESC' } })).map(toView),
      () => [...this.memory].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((r) => ({ ...r })),
    );
    return rows;
  }

  /** Une ADHESION sans compagnie liée n'est visible que des rôles "place". */
  private visibleToUser(r: { companyCode?: string }, user?: AuthenticatedUser): boolean {
    if (!user) return true;
    const tenant = resolveTenantFilter(user);
    if (!tenant) return true;
    return r.companyCode === tenant;
  }

  async list(query: ListMembershipRequestsQueryDto, user?: AuthenticatedUser): Promise<PaginatedResult<MembershipRequestViewDto>> {
    let rows = (await this.loadAll()).filter((r) => this.visibleToUser(r, user));
    if (query.type) rows = rows.filter((r) => r.type === query.type);
    if (query.state) rows = rows.filter((r) => r.state === query.state);
    return paginateArray(rows, query.page, query.pageSize);
  }

  async get(id: string, user?: AuthenticatedUser): Promise<MembershipRequestViewDto> {
    const row = (await this.loadAll()).find((r) => r.id === id);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: "Demande d'adhésion/retrait introuvable." });
    if (!this.visibleToUser(row, user)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
    return row;
  }

  async create(dto: CreateMembershipRequestDto, user: AuthenticatedUser): Promise<MembershipRequestViewDto> {
    const type = dto.type as MembershipType;
    if (!isIsoCalendarDate(dto.receivedAt)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: `Date de réception invalide : "${dto.receivedAt}".` });
    }
    if (dto.receivedAt > this.today()) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'La date de réception ne peut pas être dans le futur.' });
    }

    let companyId: string | undefined;
    let companyCode: string | undefined;
    let effectiveDate: string | undefined;
    if (type === 'ADHESION') {
      if (!dto.candidateName?.trim()) {
        throw new BadRequestException({ code: 'BAD_REQUEST', message: "Une demande d'adhésion exige la raison sociale de la société candidate (candidateName)." });
      }
      if (dto.companyId) {
        throw new BadRequestException({ code: 'BAD_REQUEST', message: "La compagnie se lie à l'acceptation de la demande d'adhésion, pas à sa création." });
      }
    } else {
      if (!dto.companyId) {
        throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Une demande de retrait exige la compagnie adhérente (companyId).' });
      }
      const company = await this.adherents.getCompany(dto.companyId);
      companyId = company.id;
      companyCode = company.code;
      const pending = (await this.loadAll()).some((r) => r.type === 'RETRAIT' && r.state === 'RECUE' && r.companyId === companyId);
      if (pending) {
        throw new ConflictException({ code: 'CONFLICT', message: `Une demande de retrait est déjà en cours pour ${company.code}.` });
      }
      effectiveDate = computeWithdrawalEffectiveDate(dto.receivedAt);
    }

    const record = {
      type,
      state: 'RECUE' as MembershipState,
      companyId,
      companyCode,
      candidateName: type === 'ADHESION' ? dto.candidateName!.trim() : undefined,
      agrementRef: dto.agrementRef?.trim() || undefined,
      receivedAt: dto.receivedAt,
      effectiveDate,
      createdBy: user.name,
    };

    return withDegradedFallback(
      'MembershipService.create',
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entity = this.repo.create(record as any);
        await this.repo.getEntityManager().persistAndFlush(entity);
        return toView(entity);
      },
      () => {
        const row: MemoryMembership = { id: randomUUID(), ...record, createdAt: this.now().toISOString() };
        this.memory.push(row);
        return { ...row };
      },
    );
  }

  async accept(id: string, dto: AcceptMembershipRequestDto, user: AuthenticatedUser): Promise<MembershipRequestViewDto> {
    const loaded = await this.loadForMutation(id);
    const current = this.viewOf(loaded);
    const state = this.assertTransition(current, 'accept');

    // Art. 30-35 : seule une société agréée pour la branche automobile peut adhérer.
    const agrementRef = dto.agrementRef?.trim() || current.agrementRef;
    if (!agrementRef) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: "L'acceptation exige la référence d'agrément pour la branche automobile (agrementRef)." });
    }
    let company: { id: string; code: string } | undefined;
    if (dto.companyId) {
      const found = await this.adherents.getCompany(dto.companyId);
      // Décision PO (2026-10-19) : une réadhésion passe par une nouvelle
      // demande, jamais par un lien direct sur une compagnie déjà
      // EXCLU/EN_RETRAIT/SUSPENDU — incohérence relevée par l'audit sécurité.
      if (found.status !== 'ACTIF') {
        throw new BadRequestException({
          code: 'COMPAGNIE_NON_ACTIVE',
          message: `${found.code} n'est pas ACTIF (statut ${found.status}) : une réadhésion passe par une nouvelle demande, pas par un lien sur cette compagnie.`,
        });
      }
      company = found;
    }

    return this.persistDecision(loaded, {
      state,
      decidedAt: this.now().toISOString(),
      decidedBy: user.name,
      decisionNote: dto.decisionNote?.trim() || undefined,
      agrementRef,
      companyId: company?.id,
      companyCode: company?.code,
    });
  }

  async reject(id: string, dto: RejectMembershipRequestDto, user: AuthenticatedUser): Promise<MembershipRequestViewDto> {
    const loaded = await this.loadForMutation(id);
    const state = this.assertTransition(this.viewOf(loaded), 'reject');
    const decisionNote = dto.decisionNote.trim();
    if (!decisionNote) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Le rejet exige un motif (decisionNote).' });
    return this.persistDecision(loaded, { state, decidedAt: this.now().toISOString(), decidedBy: user.name, decisionNote });
  }

  /**
   * Constat d'effet d'un retrait : la compagnie passe EN_RETRAIT. Les recours
   * antérieurs ne sont pas touchés — ils référencent la compagnie par son
   * code et restent dus (« les obligations restent dues pour tous les
   * sinistres antérieurs à la sortie »).
   */
  async markEffective(id: string, decisionNote: string | undefined, user: AuthenticatedUser): Promise<MembershipRequestViewDto> {
    const loaded = await this.loadForMutation(id);
    const current = this.viewOf(loaded);
    const state = this.assertTransition(current, 'effective');
    const now = this.now();
    if (!current.effectiveDate || !isWithdrawalEffectiveReached(current.effectiveDate, now)) {
      throw new ConflictException({
        code: 'INVALID_TRANSITION',
        message: `Le retrait ne peut être constaté qu'après sa date d'effet (${current.effectiveDate ?? 'inconnue'}).`,
      });
    }
    await this.adherents.markCompanyWithdrawn(current.companyId!, current.effectiveDate!);
    return this.persistDecision(loaded, { state, decidedAt: now.toISOString(), decidedBy: user.name, decisionNote: decisionNote?.trim() || undefined });
  }

  async cancel(id: string, decisionNote: string | undefined, user: AuthenticatedUser): Promise<MembershipRequestViewDto> {
    const loaded = await this.loadForMutation(id);
    const state = this.assertTransition(this.viewOf(loaded), 'cancel');
    return this.persistDecision(loaded, { state, decidedAt: this.now().toISOString(), decidedBy: user.name, decisionNote: decisionNote?.trim() || undefined });
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private assertTransition(current: MembershipRequestViewDto, action: MembershipAction): MembershipState {
    const next = nextMembershipState(current.type as MembershipType, current.state as MembershipState, action);
    if (!next) {
      throw new ConflictException({
        code: 'INVALID_TRANSITION',
        message: `Action "${action}" impossible sur une demande ${current.type} à l'état "${current.state}".`,
      });
    }
    return next;
  }

  /** Même raison que `CommissionService.loadCaseForMutation` : un 404 métier ne doit jamais déclencher le repli mémoire. */
  private async loadForMutation(id: string): Promise<Loaded> {
    try {
      const entity = await this.repo.findOne({ id });
      if (entity) return { mode: 'db', entity };
    } catch (err) {
      logDegraded('MembershipService.loadForMutation', `base de données injoignable (${(err as Error).message}) — repli mémoire`);
    }
    const row = this.memory.find((r) => r.id === id);
    if (row) return { mode: 'memory', row };
    throw new NotFoundException({ code: 'NOT_FOUND', message: "Demande d'adhésion/retrait introuvable." });
  }

  private viewOf(loaded: Loaded): MembershipRequestViewDto {
    return loaded.mode === 'db' ? toView(loaded.entity) : loaded.row;
  }

  private async persistDecision(loaded: Loaded, patch: DecisionPatch): Promise<MembershipRequestViewDto> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as DecisionPatch;
    if (loaded.mode === 'db') {
      const { decidedAt, ...rest } = defined;
      Object.assign(loaded.entity, rest, { decidedAt: new Date(decidedAt) });
      await this.repo.getEntityManager().flush();
      return toView(loaded.entity);
    }
    Object.assign(loaded.row, defined);
    return { ...loaded.row };
  }
}
