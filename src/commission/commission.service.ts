import { LockMode } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { MemoryBusinessRefCounter, nextBusinessRef } from '../common/business-ref/business-ref';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { resolveTenantFilter } from '../common/rbac/tenant-scope';
import { DEFAULT_ELIGIBILITY_CONFIG } from '../eligibility/eligibility.rules';
import { LedgerService } from '../ledger/ledger.service';
import { isValidMoney, MAX_TECHNICAL_AMOUNT_DA } from '../recours/money';
import { assertPlaceUser } from '../recours/place-role';
import { CommissionDecisionForRecours, RecoursService } from '../recours/recours.service';
import { isUniqueViolation, toConflict, withStrictFallback } from '../recours/strict-persistence';
import {
  CommissionCaseViewDto,
  CommissionSummaryDto,
  CreateCommissionCaseDto,
  DecideCommissionDto,
  ListCommissionCasesQueryDto,
  ListSanctionsQueryDto,
  PenaltyDto,
  SanctionOrderDto,
  SanctionViewDto,
} from './dto/commission.dto';
import { CommissionCase, CommissionDecisionInfo, CommissionPvInfo } from './entities/commission-case.entity';
import { Sanction } from './entities/sanction.entity';
import { canAdvanceCaseStatus, CommissionCaseStatus, isCompanyPartyToCase } from './commission.rules';

const DEFAULT_SCHEDULE_DELAY_MS = 14 * 86_400_000;
/** Délai de conciliation Art. 24 — même valeur que le KPI "hors délai de 15j" du guide illustré de référence. */
const ART24_CONCILIATION_DAYS = 15;

/** Repli mémoire — dossier de conciliation (mode dégradé, hors production). */
type MemoryCase = {
  id: string;
  reference: string;
  recoursId: string;
  recoursReference?: string;
  claimId: string;
  companyA: string;
  companyB: string;
  amount: number;
  motif: string;
  status: string;
  scheduledAt: string;
  decidedAt?: string;
  decision?: CommissionDecisionInfo;
  pv?: CommissionPvInfo;
  createdAt: string;
  version: number;
};

/** Repli mémoire — sanction. */
type MemorySanction = {
  id: string;
  commissionCaseId?: string;
  companyCode: string;
  type: string;
  amount?: number;
  reason: string;
  orderedAt: string;
  orderedBy: string;
  orderedById?: string;
  status: string;
  countersignedBy?: string;
  countersignedById?: string;
  countersignedAt?: string;
};

function toCaseView(e: CommissionCase): CommissionCaseViewDto {
  return {
    id: e.id,
    reference: e.reference,
    recoursId: e.recoursId,
    recoursReference: e.recoursReference ?? undefined,
    claimId: e.claimId,
    companyA: e.companyA,
    companyB: e.companyB,
    amount: Number(e.amount),
    motif: e.motif,
    status: e.status,
    scheduledAt: e.scheduledAt.toISOString(),
    decidedAt: e.decidedAt?.toISOString(),
    decision: e.decision ? { outcome: e.decision.outcome, motif: e.decision.motif } : undefined,
    pv: e.pv,
    createdAt: e.createdAt.toISOString(),
  };
}

function toCaseViewFromMemory(row: MemoryCase): CommissionCaseViewDto {
  const { version: _version, decision, ...rest } = row;
  return { ...rest, decision: decision ? { outcome: decision.outcome, motif: decision.motif } : undefined };
}

function toSanctionView(e: Sanction): SanctionViewDto {
  return {
    id: e.id,
    commissionCaseId: e.commissionCaseId,
    companyCode: e.companyCode,
    type: e.type,
    amount: e.amount === undefined || e.amount === null ? undefined : Number(e.amount),
    reason: e.reason,
    orderedAt: e.orderedAt.toISOString(),
    orderedBy: e.orderedBy,
    status: e.status,
    countersignedBy: e.countersignedBy,
    countersignedAt: e.countersignedAt?.toISOString(),
  };
}

function toSanctionViewFromMemory(row: MemorySanction): SanctionViewDto {
  const { orderedById: _o, countersignedById: _c, ...rest } = row;
  return rest;
}

const CASE_NOT_FOUND = () => new NotFoundException({ code: 'NOT_FOUND', message: 'Dossier de commission introuvable.' });
const CONCURRENT = () => new ConflictException({ code: 'CONFLIT_CONCURRENT', message: 'Le dossier a été modifié entre-temps : rechargez-le avant de recommencer.' });

/** Plafond des pénalités financières (SEC-32) — paramétrable ; défaut : plafond conventionnel Art. 4 (valeur à confirmer par l'UAR). */
function parsePenaltyCap(raw: string | undefined, fallback: string | undefined): number {
  const text = (raw ?? fallback ?? '').trim();
  if (!text) return DEFAULT_ELIGIBILITY_CONFIG.maxAmountDA;
  const value = Number(text);
  if (!/^\d+(\.\d{1,2})?$/.test(text) || value <= 0 || value > MAX_TECHNICAL_AMOUNT_DA) {
    throw new Error(`Configuration invalide : COMMISSION_PENALTY_MAX_DA="${text}".`);
  }
  return value;
}

/**
 * CommissionModule — B.2, écran 7 "Commission" : file de conciliation
 * (`CommissionCase`), prononcé de pénalités/sanctions (`Sanction`), PV.
 * Dépend de `RecoursModule` (interface publique) — jamais l'inverse.
 *
 * Revue sécurité 2026-10-19 :
 *  - SEC-32 : dossier ouvert seulement pour un recours en COMMISSION, un seul
 *    par recours ; PV signé une seule fois, référence générée par le serveur,
 *    par une autre personne que l'auteur du prononcé (collégialité minimale) ;
 *    pénalités/sanctions seulement après décision prononcée au PV signé,
 *    uniques par (dossier, compagnie, type), plafonnées, et contresignées par
 *    un second membre ; la clôture du recours exige ce PV (voir
 *    `RecoursService.registerCommissionDecisionLookup`) ; tout est scellé au journal ;
 *  - SEC-25 : actes de commission réservés aux rôles place, même avec un privilège obtenu par dérogation ;
 *  - SEC-33 : transitions sous verrou + version ;
 *  - SEC-46 : hors périmètre, 404 identique à un dossier inexistant (routes de ce module).
 */
@Injectable()
export class CommissionService implements OnModuleInit {
  private readonly memoryCases: MemoryCase[] = [];
  private readonly memoryRefs = new MemoryBusinessRefCounter();
  private readonly memorySanctions: MemorySanction[] = [];
  private readonly penaltyCap: number;

  constructor(
    @InjectRepository(CommissionCase) private readonly caseRepo: EntityRepository<CommissionCase>,
    @InjectRepository(Sanction) private readonly sanctionRepo: EntityRepository<Sanction>,
    private readonly recours: RecoursService,
    @Optional() private readonly ledger?: LedgerService,
    @Optional() configService?: ConfigService,
  ) {
    this.penaltyCap = parsePenaltyCap(configService?.get<string>('COMMISSION_PENALTY_MAX_DA'), configService?.get<string>('ELIGIBILITY_MAX_AMOUNT_DA'));
  }

  /** SEC-32 : expose au RecoursModule la décision de commission d'un recours (clôture conditionnée au PV signé). */
  onModuleInit(): void {
    this.recours.registerCommissionDecisionLookup((recoursId) => this.decisionForRecours(recoursId));
  }

  async decisionForRecours(recoursId: string): Promise<CommissionDecisionForRecours | undefined> {
    const kase = (await this.loadAllCaseViews()).find((c) => c.recoursId === recoursId);
    if (!kase) return undefined;
    return { caseId: kase.id, status: kase.status, outcome: kase.decision?.outcome as CommissionDecisionForRecours['outcome'], pvRef: kase.pv?.ref, pvSigned: !!kase.pv };
  }

  private async seal(type: string, ref: string, actorId: string, summary: Record<string, unknown>): Promise<void> {
    if (this.ledger) await this.ledger.append(type, ref, actorId, JSON.stringify(summary));
  }

  private freshEm(repo: { getEntityManager(): unknown }): EntityManager {
    return (repo.getEntityManager() as EntityManager).fork({ clear: true });
  }

  private async loadAllCaseViews(): Promise<CommissionCaseViewDto[]> {
    return withDegradedFallback(
      'CommissionService.loadAllCaseViews',
      async () => {
        const rows = await this.freshEm(this.caseRepo).find(CommissionCase, {}, { orderBy: { scheduledAt: 'DESC' } });
        return rows.map(toCaseView);
      },
      () => [...this.memoryCases].sort((a, b) => (a.scheduledAt < b.scheduledAt ? 1 : -1)).map(toCaseViewFromMemory),
    );
  }

  /** B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que les dossiers où sa compagnie est `companyA` ou `companyB` ; les rôles "place" voient tout. */
  private visibleToUser(r: { companyA: string; companyB: string }, user?: AuthenticatedUser): boolean {
    if (!user) return true;
    const tenant = resolveTenantFilter(user);
    if (!tenant) return true;
    return r.companyA === tenant || r.companyB === tenant;
  }

  async listCases(query: ListCommissionCasesQueryDto, user?: AuthenticatedUser): Promise<PaginatedResult<CommissionCaseViewDto>> {
    let rows = await this.loadAllCaseViews();
    rows = rows.filter((r) => this.visibleToUser(r, user));
    if (query.status) rows = rows.filter((r) => r.status === query.status);
    return paginateArray(rows, query.page, query.pageSize);
  }

  /** Interface inter-modules historique (DocumentsModule) : 404 si inexistant, 403 si hors périmètre. */
  async getCase(id: string, user?: AuthenticatedUser): Promise<CommissionCaseViewDto> {
    const rows = await this.loadAllCaseViews();
    const row = rows.find((r) => r.id === id);
    if (!row) throw CASE_NOT_FOUND();
    if (!this.visibleToUser(row, user)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
    return row;
  }

  /** SEC-46 — routes de ce module : hors périmètre, réponse identique à un dossier inexistant. */
  async getCaseForUser(id: string, user: AuthenticatedUser): Promise<CommissionCaseViewDto> {
    const row = (await this.loadAllCaseViews()).find((r) => r.id === id);
    if (!row || !this.visibleToUser(row, user)) throw CASE_NOT_FOUND();
    return row;
  }

  /**
   * Ouverture d'un dossier de conciliation : le recours doit être visible de
   * l'appelant (404 sinon, SEC-46), à l'état COMMISSION (SEC-32) et sans
   * dossier existant (SEC-20 : `UNIQUE(recours_id)`, 409).
   */
  async createCase(dto: CreateCommissionCaseDto, user: AuthenticatedUser): Promise<CommissionCaseViewDto> {
    const recours = await this.recours.getForUser(dto.recoursId, user);
    if (recours.state !== 'COMMISSION') {
      throw new ConflictException({ code: 'RECOURS_HORS_COMMISSION', message: 'Un dossier de commission ne s’ouvre que pour un recours transmis en commission.' });
    }
    const now = new Date();
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : new Date(now.getTime() + DEFAULT_SCHEDULE_DELAY_MS);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < now.getTime()) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'La date de séance ne peut pas être dans le passé.' });
    }
    const duplicate = () => new ConflictException({ code: 'DOSSIER_COMMISSION_EXISTANT', message: 'Un dossier de commission existe déjà pour ce recours.' });
    const summary = { recoursId: recours.id, claimId: recours.claimId, companyA: recours.from, companyB: recours.to, amount: recours.amount, role: user.role };

    return withStrictFallback(
      'CommissionService.createCase',
      async () => {
        try {
          return await this.freshEm(this.caseRepo).transactional(async (tem) => {
            if (await tem.findOne(CommissionCase, { recoursId: recours.id })) throw duplicate();
            const entity = tem.create(CommissionCase, {
              // Attribuée dans la transaction : un échec d'ouverture ne consomme pas de numéro.
              reference: await nextBusinessRef(tem, 'CSC', now),
              recoursId: recours.id,
              recoursReference: recours.reference,
              claimId: recours.claimId,
              companyA: recours.from,
              companyB: recours.to,
              amount: recours.amount,
              motif: dto.motif,
              status: 'A_INSTRUIRE',
              scheduledAt,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);
            await tem.flush();
            await this.seal('COMMISSION_SAISINE', entity.id, user.id, summary);
            return toCaseView(entity);
          });
        } catch (err) {
          throw isUniqueViolation(err) ? duplicate() : err;
        }
      },
      async () => {
        if (this.memoryCases.some((c) => c.recoursId === recours.id)) throw duplicate();
        const row: MemoryCase = {
          id: randomUUID(),
          reference: this.memoryRefs.next('CSC', now),
          recoursId: recours.id,
          recoursReference: recours.reference,
          claimId: recours.claimId,
          companyA: recours.from,
          companyB: recours.to,
          amount: recours.amount,
          motif: dto.motif,
          status: 'A_INSTRUIRE',
          scheduledAt: scheduledAt.toISOString(),
          createdAt: now.toISOString(),
          version: 1,
        };
        this.memoryCases.push(row);
        await this.seal('COMMISSION_SAISINE', row.id, user.id, summary);
        return toCaseViewFromMemory(row);
      },
    );
  }

  /**
   * Mutation d'un dossier sous verrou (SEC-33) : `mutate` reçoit l'état
   * courant et renvoie le patch à appliquer (ou lève une erreur métier) ; la
   * même logique sert la base (transaction + `SELECT … FOR UPDATE` + version)
   * et le repli mémoire (comparer-et-écrire synchrone).
   */
  private async mutateCase(
    id: string,
    mutate: (current: CommissionCaseViewDto & { decidedBy?: string }) => Promise<Partial<Pick<MemoryCase, 'status' | 'decidedAt' | 'decision' | 'pv'>>> | Partial<Pick<MemoryCase, 'status' | 'decidedAt' | 'decision' | 'pv'>>,
    sealType: string,
    actorId: string,
  ): Promise<CommissionCaseViewDto> {
    return withStrictFallback(
      'CommissionService.mutateCase',
      async () => {
        try {
          return await this.freshEm(this.caseRepo).transactional(async (tem) => {
            const e = await tem.findOne(CommissionCase, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
            if (!e) throw CASE_NOT_FOUND();
            const patch = await mutate({ ...toCaseView(e), decidedBy: e.decision?.decidedBy });
            if (patch.status) e.status = patch.status;
            if (patch.decidedAt) e.decidedAt = new Date(patch.decidedAt);
            if (patch.decision) e.decision = patch.decision;
            if (patch.pv) e.pv = patch.pv;
            await tem.flush();
            await this.seal(sealType, id, actorId, { status: e.status, outcome: e.decision?.outcome, pvRef: e.pv?.ref });
            return toCaseView(e);
          });
        } catch (err) {
          throw toConflict(err, 'CONFLIT_CONCURRENT', 'Le dossier a été modifié entre-temps : rechargez-le avant de recommencer.');
        }
      },
      async () => {
        const row = this.memoryCases.find((r) => r.id === id);
        if (!row) throw CASE_NOT_FOUND();
        const version = row.version;
        const patch = await mutate({ ...toCaseViewFromMemory(row), decidedBy: row.decision?.decidedBy });
        if (row.version !== version) throw CONCURRENT();
        Object.assign(row, patch);
        row.version += 1;
        await this.seal(sealType, id, actorId, { status: row.status, outcome: row.decision?.outcome, pvRef: row.pv?.ref });
        return toCaseViewFromMemory(row);
      },
    );
  }

  async deliberate(id: string, user: AuthenticatedUser): Promise<CommissionCaseViewDto> {
    assertPlaceUser(user);
    return this.mutateCase(
      id,
      (current) => {
        if (!canAdvanceCaseStatus(current.status as CommissionCaseStatus, 'EN_DELIBERE')) {
          throw new BadRequestException({ code: 'INVALID_TRANSITION', message: `Impossible de délibérer depuis l'état "${current.status}".` });
        }
        return { status: 'EN_DELIBERE' };
      },
      'COMMISSION_DELIBERE',
      user.id,
    );
  }

  async decide(id: string, dto: DecideCommissionDto, user: AuthenticatedUser): Promise<CommissionCaseViewDto> {
    assertPlaceUser(user);
    return this.mutateCase(
      id,
      (current) => {
        if (!canAdvanceCaseStatus(current.status as CommissionCaseStatus, 'PRONONCE')) {
          throw new BadRequestException({
            code: 'INVALID_TRANSITION',
            message: `Impossible de prononcer une décision depuis l'état "${current.status}" (délibération requise au préalable).`,
          });
        }
        return {
          status: 'PRONONCE',
          decidedAt: new Date().toISOString(),
          decision: { outcome: dto.outcome as CommissionDecisionInfo['outcome'], motif: dto.motif, decidedBy: user.id },
        };
      },
      'COMMISSION_DECISION',
      user.id,
    );
  }

  /** SEC-32 : PV signé une seule fois (409), référence générée par le serveur, par une autre personne que l'auteur du prononcé. */
  async pvSign(id: string, user: AuthenticatedUser): Promise<CommissionCaseViewDto> {
    assertPlaceUser(user);
    return this.mutateCase(
      id,
      (current) => {
        if (current.status !== 'PRONONCE') {
          throw new BadRequestException({ code: 'INVALID_TRANSITION', message: 'Le PV ne peut être signé qu’après le prononcé de la décision.' });
        }
        if (current.pv) throw new ConflictException({ code: 'PV_DEJA_SIGNE', message: 'Le PV de ce dossier est déjà signé : il ne se réécrit pas.' });
        if (current.decidedBy && current.decidedBy === user.id) {
          throw new ConflictException({ code: 'FOUR_EYES', message: 'Le PV doit être signé par un autre membre que l’auteur du prononcé.' });
        }
        return { pv: { signedBy: user.name, signedAt: new Date().toISOString(), ref: `PV-${id}` } };
      },
      'COMMISSION_PV',
      user.id,
    );
  }

  /** SEC-32 : une sanction suppose une décision prononcée dont le PV est signé, et vise une partie au dossier. */
  private async assertSanctionable(id: string, companyCode: string): Promise<CommissionCaseViewDto> {
    const kase = (await this.loadAllCaseViews()).find((c) => c.id === id);
    if (!kase) throw CASE_NOT_FOUND();
    if (kase.status !== 'PRONONCE' || !kase.pv) {
      throw new ConflictException({ code: 'DECISION_REQUISE', message: 'Une pénalité ou une sanction exige une décision prononcée dont le PV est signé.' });
    }
    if (!isCompanyPartyToCase(companyCode, kase.companyA, kase.companyB)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'La compagnie visée n’est pas partie à ce dossier.' });
    }
    return kase;
  }

  async penalty(id: string, dto: PenaltyDto, user: AuthenticatedUser): Promise<SanctionViewDto> {
    assertPlaceUser(user);
    if (!isValidMoney(dto.amount)) {
      throw new BadRequestException({ code: 'MONTANT_INVALIDE', message: 'Montant invalide : nombre fini, strictement positif, deux décimales au plus.' });
    }
    if (dto.amount > this.penaltyCap) {
      throw new BadRequestException({ code: 'PENALITE_PLAFOND', message: `Pénalité supérieure au plafond paramétré (${this.penaltyCap} DA).` });
    }
    await this.assertSanctionable(id, dto.companyCode);
    return this.persistSanction({ commissionCaseId: id, companyCode: dto.companyCode, type: 'PENALITE_FINANCIERE', amount: dto.amount, reason: dto.reason, orderedBy: user.name, orderedById: user.id });
  }

  async sanction(id: string, dto: SanctionOrderDto, user: AuthenticatedUser): Promise<SanctionViewDto> {
    assertPlaceUser(user);
    await this.assertSanctionable(id, dto.companyCode);
    return this.persistSanction({ commissionCaseId: id, companyCode: dto.companyCode, type: dto.type, reason: dto.reason, orderedBy: user.name, orderedById: user.id });
  }

  private async persistSanction(record: Omit<MemorySanction, 'id' | 'orderedAt' | 'status'>): Promise<SanctionViewDto> {
    const duplicate = () => new ConflictException({ code: 'SANCTION_EXISTANTE', message: 'Cette mesure a déjà été proposée pour cette compagnie dans ce dossier.' });
    const summary = { case: record.commissionCaseId, company: record.companyCode, type: record.type, amount: record.amount, status: 'A_CONTRESIGNER' };
    return withStrictFallback(
      'CommissionService.persistSanction',
      async () => {
        try {
          return await this.freshEm(this.sanctionRepo).transactional(async (tem) => {
            const entity = tem.create(Sanction, { ...record, status: 'A_CONTRESIGNER' } as never);
            await tem.flush();
            await this.seal('SANCTION_PROPOSEE', entity.id, record.orderedById ?? record.orderedBy, summary);
            return toSanctionView(entity);
          });
        } catch (err) {
          throw isUniqueViolation(err) ? duplicate() : err;
        }
      },
      async () => {
        if (this.memorySanctions.some((s) => s.commissionCaseId === record.commissionCaseId && s.companyCode === record.companyCode && s.type === record.type)) throw duplicate();
        const row: MemorySanction = { id: randomUUID(), orderedAt: new Date().toISOString(), status: 'A_CONTRESIGNER', ...record };
        this.memorySanctions.push(row);
        await this.seal('SANCTION_PROPOSEE', row.id, record.orderedById ?? record.orderedBy, summary);
        return toSanctionViewFromMemory(row);
      },
    );
  }

  /** SEC-32 : contreseing d'une sanction par un second membre de la place (jamais l'auteur de la proposition). */
  async countersignSanction(sanctionId: string, user: AuthenticatedUser): Promise<SanctionViewDto> {
    assertPlaceUser(user);
    const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'Sanction introuvable.' });
    const check = (s: { status: string; orderedById?: string }) => {
      if (s.status !== 'A_CONTRESIGNER') throw new ConflictException({ code: 'SANCTION_DEJA_PRONONCEE', message: 'Cette sanction est déjà prononcée.' });
      if (s.orderedById === user.id) throw new ConflictException({ code: 'FOUR_EYES', message: 'La sanction doit être contresignée par un autre membre que son auteur.' });
    };
    const at = new Date();
    return withStrictFallback(
      'CommissionService.countersignSanction',
      async () => {
        try {
          return await this.freshEm(this.sanctionRepo).transactional(async (tem) => {
            const s = await tem.findOne(Sanction, { id: sanctionId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
            if (!s) throw notFound();
            check(s);
            Object.assign(s, { status: 'PRONONCEE', countersignedBy: user.name, countersignedById: user.id, countersignedAt: at });
            await tem.flush();
            await this.seal('SANCTION_PRONONCEE', s.id, user.id, { case: s.commissionCaseId, company: s.companyCode, type: s.type, amount: s.amount, proposedBy: s.orderedById });
            return toSanctionView(s);
          });
        } catch (err) {
          throw toConflict(err, 'CONFLIT_CONCURRENT', 'La sanction a été modifiée entre-temps.');
        }
      },
      async () => {
        const s = this.memorySanctions.find((r) => r.id === sanctionId);
        if (!s) throw notFound();
        check(s);
        Object.assign(s, { status: 'PRONONCEE', countersignedBy: user.name, countersignedById: user.id, countersignedAt: at.toISOString() });
        await this.seal('SANCTION_PRONONCEE', s.id, user.id, { case: s.commissionCaseId, company: s.companyCode, type: s.type, amount: s.amount, proposedBy: s.orderedById });
        return toSanctionViewFromMemory(s);
      },
    );
  }

  /** B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que les sanctions de SA compagnie, quel que soit le filtre `company` demandé. */
  async listSanctions(query: ListSanctionsQueryDto, user?: AuthenticatedUser): Promise<PaginatedResult<SanctionViewDto>> {
    const rows = await withDegradedFallback(
      'CommissionService.listSanctions',
      async () => {
        const all = await this.freshEm(this.sanctionRepo).find(Sanction, {}, { orderBy: { orderedAt: 'DESC' } });
        return all.map(toSanctionView);
      },
      () => [...this.memorySanctions].sort((a, b) => (a.orderedAt < b.orderedAt ? 1 : -1)).map(toSanctionViewFromMemory),
    );
    const tenant = user ? resolveTenantFilter(user) : undefined;
    const effectiveCompany = tenant ?? query.company;
    let filtered = effectiveCompany ? rows.filter((r) => r.companyCode === effectiveCompany) : rows;
    if (query.status) filtered = filtered.filter((r) => r.status === query.status);
    return paginateArray(filtered, query.page, query.pageSize);
  }

  /** KPI de synthèse (écran 7) — même scoping tenant que `listCases()`. */
  async summary(user?: AuthenticatedUser): Promise<CommissionSummaryDto> {
    const rows = (await this.loadAllCaseViews()).filter((r) => this.visibleToUser(r, user));
    const now = Date.now();

    const pending = rows.filter((r) => r.status !== 'PRONONCE');
    const overdue15d = pending.filter((r) => now - new Date(r.createdAt).getTime() > ART24_CONCILIATION_DAYS * 86_400_000);
    const recoursFondes = rows.filter((r) => r.status === 'PRONONCE' && r.decision?.outcome === 'RECOURS_FONDE');

    const tenant = user ? resolveTenantFilter(user) : undefined;
    const allRecours = await this.recours.listAll();
    const oppositionsFondees = allRecours.filter(
      (r) => r.resolution?.kind === 'OPPOSITION_FONDEE_ART12' && (!tenant || r.from === tenant || r.to === tenant),
    );

    return {
      pendingCount: pending.length,
      overdue15dCount: overdue15d.length,
      recoursFondesCount: recoursFondes.length,
      oppositionsFondeesCount: oppositionsFondees.length,
    };
  }
}
