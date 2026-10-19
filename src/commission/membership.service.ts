import { LockMode } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { AdherentsService } from '../adherents/adherents.service';
import { CLOCK, Clock, systemClock } from '../common/clock';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { resolveTenantFilter } from '../common/rbac/tenant-scope';
import { LedgerService } from '../ledger/ledger.service';
import { assertPlaceUser } from '../recours/place-role';
import { parseIntSetting } from '../recours/recours.rules';
import { isUniqueViolation, toConflict, withStrictFallback } from '../recours/strict-persistence';
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

type DecisionPatch = Required<Pick<MemoryMembership, 'state' | 'decidedAt' | 'decidedBy'>> &
  Partial<Pick<MemoryMembership, 'decisionNote' | 'agrementRef' | 'companyId' | 'companyCode'>>;

const NOT_FOUND = () => new NotFoundException({ code: 'NOT_FOUND', message: "Demande d'adhésion/retrait introuvable." });

function daysBefore(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

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
    letterRef: e.letterRef,
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
 *
 * Revue sécurité 2026-10-19 :
 *  - SEC-47 : référence du courrier obligatoire, antériorité de la date de
 *    réception plafonnée (`MEMBERSHIP_RECEIVED_MAX_AGE_DAYS`, 30 jours par
 *    défaut — valeur à confirmer par l'UAR) : un retrait reçu en octobre ne
 *    peut plus être antidaté au 30/09 pour avancer son effet d'un an ; le
 *    constat d'effet et le passage de la compagnie EN_RETRAIT sont écrits
 *    dans UNE transaction ;
 *  - SEC-20 : une seule demande de retrait RECUE par compagnie (index unique partiel, 409) ;
 *  - SEC-25 : instruction réservée aux rôles place ; chaque acte est scellé au journal.
 */
@Injectable()
export class MembershipService {
  private readonly memory: MemoryMembership[] = [];
  private readonly now: Clock;
  private readonly maxAgeDays: number;

  constructor(
    @InjectRepository(MembershipRequest) private readonly repo: EntityRepository<MembershipRequest>,
    private readonly adherents: AdherentsService,
    @Optional() @Inject(CLOCK) clock?: Clock,
    @Optional() private readonly ledger?: LedgerService,
    @Optional() configService?: ConfigService,
  ) {
    this.now = clock ?? systemClock;
    this.maxAgeDays = parseIntSetting('MEMBERSHIP_RECEIVED_MAX_AGE_DAYS', configService?.get<string>('MEMBERSHIP_RECEIVED_MAX_AGE_DAYS'), 30, 0, 366);
  }

  private freshEm(): EntityManager {
    return (this.repo.getEntityManager() as EntityManager).fork({ clear: true });
  }

  private async seal(type: string, ref: string, actorId: string, summary: Record<string, unknown>): Promise<void> {
    if (this.ledger) await this.ledger.append(type, ref, actorId, JSON.stringify(summary));
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
    assertPlaceUser(user);
    const type = dto.type as MembershipType;
    if (!isIsoCalendarDate(dto.receivedAt)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: `Date de réception invalide : "${dto.receivedAt}".` });
    }
    if (dto.receivedAt > this.today()) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'La date de réception ne peut pas être dans le futur.' });
    }
    // SEC-47 : antériorité plafonnée — la date de réception déclarée ne peut pas précéder l'enregistrement de plus de N jours.
    const oldest = daysBefore(this.today(), this.maxAgeDays);
    if (dto.receivedAt < oldest) {
      throw new BadRequestException({
        code: 'DATE_RECEPTION_TROP_ANCIENNE',
        message: `La date de réception ne peut pas être antérieure au ${oldest} (${this.maxAgeDays} jours avant l'enregistrement).`,
      });
    }
    const letterRef = dto.letterRef?.trim();
    if (!letterRef) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'La référence du courrier reçu (letterRef) est obligatoire.' });

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
      if (pending) throw this.pendingConflict(company.code);
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
      letterRef,
      createdBy: user.name,
    };
    const summary = { type, company: companyCode, receivedAt: dto.receivedAt, effectiveDate, letterRef };

    return withStrictFallback(
      'MembershipService.create',
      async () => {
        try {
          return await this.freshEm().transactional(async (tem) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const entity = tem.create(MembershipRequest, record as any);
            await tem.flush();
            await this.seal('ADHESION_DEMANDE', entity.id, user.id, summary);
            return toView(entity);
          });
        } catch (err) {
          throw isUniqueViolation(err) ? this.pendingConflict(companyCode ?? '') : err;
        }
      },
      async () => {
        // Section synchrone : vérification + insertion atomiques (mode dégradé).
        if (type === 'RETRAIT' && this.memory.some((r) => r.type === 'RETRAIT' && r.state === 'RECUE' && r.companyId === companyId)) throw this.pendingConflict(companyCode ?? '');
        const row: MemoryMembership = { id: randomUUID(), ...record, createdAt: this.now().toISOString() };
        this.memory.push(row);
        await this.seal('ADHESION_DEMANDE', row.id, user.id, summary);
        return { ...row };
      },
    );
  }

  private pendingConflict(code: string): ConflictException {
    return new ConflictException({ code: 'CONFLICT', message: `Une demande de retrait est déjà en cours pour ${code}.` });
  }

  async accept(id: string, dto: AcceptMembershipRequestDto, user: AuthenticatedUser): Promise<MembershipRequestViewDto> {
    assertPlaceUser(user);
    const current = await this.getRaw(id);
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

    return this.persistDecision(id, 'accept', user, {
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
    assertPlaceUser(user);
    const state = this.assertTransition(await this.getRaw(id), 'reject');
    const decisionNote = dto.decisionNote.trim();
    if (!decisionNote) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Le rejet exige un motif (decisionNote).' });
    return this.persistDecision(id, 'reject', user, { state, decidedAt: this.now().toISOString(), decidedBy: user.name, decisionNote });
  }

  /**
   * Constat d'effet d'un retrait : la compagnie passe EN_RETRAIT. Les recours
   * antérieurs ne sont pas touchés — ils référencent la compagnie par son
   * code et restent dus (« les obligations restent dues pour tous les
   * sinistres antérieurs à la sortie »).
   */
  async markEffective(id: string, decisionNote: string | undefined, user: AuthenticatedUser): Promise<MembershipRequestViewDto> {
    assertPlaceUser(user);
    const current = await this.getRaw(id);
    const state = this.assertTransition(current, 'effective');
    const now = this.now();
    if (!current.effectiveDate || !isWithdrawalEffectiveReached(current.effectiveDate, now)) {
      throw new ConflictException({
        code: 'INVALID_TRANSITION',
        message: `Le retrait ne peut être constaté qu'après sa date d'effet (${current.effectiveDate ?? 'inconnue'}).`,
      });
    }
    // SEC-47 : passage de la compagnie EN_RETRAIT et constat de la demande dans la même transaction (voir persistDecision).
    return this.persistDecision(
      id,
      'effective',
      user,
      { state, decidedAt: now.toISOString(), decidedBy: user.name, decisionNote: decisionNote?.trim() || undefined },
      () => this.adherents.markCompanyWithdrawn(current.companyId!, current.effectiveDate!, user),
    );
  }

  async cancel(id: string, decisionNote: string | undefined, user: AuthenticatedUser): Promise<MembershipRequestViewDto> {
    assertPlaceUser(user);
    const state = this.assertTransition(await this.getRaw(id), 'cancel');
    return this.persistDecision(id, 'cancel', user, { state, decidedAt: this.now().toISOString(), decidedBy: user.name, decisionNote: decisionNote?.trim() || undefined });
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

  /** Lecture de la demande (base, sinon repli mémoire hors production) — un 404 métier ne déclenche jamais de repli. */
  private async getRaw(id: string): Promise<MembershipRequestViewDto> {
    const row = (await this.loadAll()).find((r) => r.id === id);
    if (!row) throw NOT_FOUND();
    return row;
  }

  /**
   * Écrit une décision sous verrou : la demande est relue dans la transaction
   * (`SELECT ... FOR UPDATE`) et la transition revérifiée ; l'effet de bord
   * éventuel (`sideEffect`, ex. passage EN_RETRAIT de la compagnie) s'exécute
   * dans la MÊME transaction ; l'acte est scellé au journal (SEC-47/SEC-33).
   */
  private async persistDecision(id: string, action: MembershipAction, user: AuthenticatedUser, patch: DecisionPatch, sideEffect?: () => Promise<unknown>): Promise<MembershipRequestViewDto> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as DecisionPatch;
    const sealType = `ADHESION_${action.toUpperCase()}`;
    return withStrictFallback(
      'MembershipService.persistDecision',
      async () => {
        try {
          return await this.freshEm().transactional(async (tem) => {
            const e = await tem.findOne(MembershipRequest, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
            if (!e) throw NOT_FOUND();
            this.assertTransition(toView(e), action);
            if (sideEffect) await sideEffect();
            const { decidedAt, ...rest } = defined;
            Object.assign(e, rest, { decidedAt: new Date(decidedAt) });
            await tem.flush();
            await this.seal(sealType, id, user.id, { type: e.type, state: e.state, company: e.companyCode });
            return toView(e);
          });
        } catch (err) {
          throw toConflict(err, 'CONFLIT_CONCURRENT', 'La demande a été modifiée entre-temps.');
        }
      },
      async () => {
        const row = this.memory.find((r) => r.id === id);
        if (!row) throw NOT_FOUND();
        this.assertTransition(row, action);
        const stateBefore = row.state;
        if (sideEffect) await sideEffect();
        // Comparer-et-écrire synchrone (mode dégradé).
        if (row.state !== stateBefore) throw new ConflictException({ code: 'CONFLIT_CONCURRENT', message: 'La demande a été modifiée entre-temps.' });
        Object.assign(row, defined);
        await this.seal(sealType, id, user.id, { type: row.type, state: row.state, company: row.companyCode });
        return { ...row };
      },
    );
  }
}
