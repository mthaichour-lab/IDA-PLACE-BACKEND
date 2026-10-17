import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { logDegraded, withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { resolveTenantFilter } from '../common/rbac/tenant-scope';
import { RecoursService } from '../recours/recours.service';
import {
  CommissionCaseViewDto,
  CreateCommissionCaseDto,
  DecideCommissionDto,
  ListCommissionCasesQueryDto,
  ListSanctionsQueryDto,
  PenaltyDto,
  PvSignDto,
  SanctionOrderDto,
  SanctionViewDto,
} from './dto/commission.dto';
import { CommissionCase, CommissionDecisionInfo, CommissionPvInfo } from './entities/commission-case.entity';
import { Sanction } from './entities/sanction.entity';
import { canAdvanceCaseStatus, CommissionCaseStatus, isCompanyPartyToCase } from './commission.rules';

const DEFAULT_SCHEDULE_DELAY_MS = 14 * 86_400_000;

/** Repli mémoire — dossier de conciliation. */
type MemoryCase = {
  id: string;
  recoursId: string;
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
};

function toCaseView(e: CommissionCase): CommissionCaseViewDto {
  return {
    id: e.id,
    recoursId: e.recoursId,
    claimId: e.claimId,
    companyA: e.companyA,
    companyB: e.companyB,
    amount: e.amount,
    motif: e.motif,
    status: e.status,
    scheduledAt: e.scheduledAt.toISOString(),
    decidedAt: e.decidedAt?.toISOString(),
    decision: e.decision,
    pv: e.pv,
    createdAt: e.createdAt.toISOString(),
  };
}

function toCaseViewFromMemory(row: MemoryCase): CommissionCaseViewDto {
  return { ...row };
}

function toSanctionView(e: Sanction): SanctionViewDto {
  return {
    id: e.id,
    commissionCaseId: e.commissionCaseId,
    companyCode: e.companyCode,
    type: e.type,
    amount: e.amount,
    reason: e.reason,
    orderedAt: e.orderedAt.toISOString(),
    orderedBy: e.orderedBy,
  };
}

function toSanctionViewFromMemory(row: MemorySanction): SanctionViewDto {
  return { ...row };
}

/**
 * CommissionModule — B.2, écran 7 "Commission" : file de conciliation
 * (`CommissionCase`), prononcé de pénalités/sanctions (`Sanction`), PV de
 * commission. Dépend de `RecoursModule` (lecture seule, interface publique
 * `RecoursService.get()`) pour valider et dénormaliser `claimId`/
 * `companyA`/`companyB`/`amount` à l'ouverture d'un dossier — jamais
 * l'inverse (pas de cycle, voir ARCHITECTURE.md). La transmission
 * `RecoursModule -> CommissionModule` reste pour l'instant une action
 * MANUELLE en deux temps (voir HANDOFF.md, limite connue) : le correspondant
 * ouvre le dossier de commission via `POST /commission/cases` après avoir
 * transitionné le recours en `COMMISSION` (`transmettre_commission`).
 */
@Injectable()
export class CommissionService {
  private readonly memoryCases: MemoryCase[] = [];
  private readonly memorySanctions: MemorySanction[] = [];

  constructor(
    @InjectRepository(CommissionCase) private readonly caseRepo: EntityRepository<CommissionCase>,
    @InjectRepository(Sanction) private readonly sanctionRepo: EntityRepository<Sanction>,
    private readonly recours: RecoursService,
  ) {}

  private async loadAllCaseViews(): Promise<CommissionCaseViewDto[]> {
    return withDegradedFallback(
      'CommissionService.loadAllCaseViews',
      async () => {
        const rows = await this.caseRepo.findAll({ orderBy: { scheduledAt: 'DESC' } });
        return rows.map(toCaseView);
      },
      () => [...this.memoryCases].sort((a, b) => (a.scheduledAt < b.scheduledAt ? 1 : -1)).map(toCaseViewFromMemory),
    );
  }

  /** B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que les dossiers où sa compagnie est `companyA` ou `companyB` ; les rôles "place" (dont les membres de la commission) voient tout. Ajouté par cohérence avec Recours/Settlement — absent jusqu'ici (voir revue Product Owner, sprint 3 : signalé comme question ouverte, tranché par défaut vers le scoping plutôt que la transparence totale, à confirmer avec l'UAR si une transparence de place était en fait voulue). */
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

  async getCase(id: string, user?: AuthenticatedUser): Promise<CommissionCaseViewDto> {
    const rows = await this.loadAllCaseViews();
    const row = rows.find((r) => r.id === id);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Dossier de commission introuvable.' });
    if (!this.visibleToUser(row, user)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
    return row;
  }

  async createCase(dto: CreateCommissionCaseDto): Promise<CommissionCaseViewDto> {
    // Validation + dénormalisation depuis RecoursModule (interface publique
    // en lecture seule) — lève un 404 normalisé si le recours n'existe pas.
    const recours = await this.recours.get(dto.recoursId);
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : new Date(Date.now() + DEFAULT_SCHEDULE_DELAY_MS);

    return withDegradedFallback(
      'CommissionService.createCase',
      async () => {
        const entity = this.caseRepo.create({
          recoursId: recours.id,
          claimId: recours.claimId,
          companyA: recours.from,
          companyB: recours.to,
          amount: recours.amount,
          motif: dto.motif,
          status: 'A_INSTRUIRE',
          scheduledAt,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await this.caseRepo.getEntityManager().persistAndFlush(entity);
        return toCaseView(entity);
      },
      () => {
        const row: MemoryCase = {
          id: randomUUID(),
          recoursId: recours.id,
          claimId: recours.claimId,
          companyA: recours.from,
          companyB: recours.to,
          amount: recours.amount,
          motif: dto.motif,
          status: 'A_INSTRUIRE',
          scheduledAt: scheduledAt.toISOString(),
          createdAt: new Date().toISOString(),
        };
        this.memoryCases.push(row);
        return toCaseViewFromMemory(row);
      },
    );
  }

  /**
   * Récupère un dossier (DB ou repli mémoire) SANS passer par
   * `withDegradedFallback` — même raison que `RecoursService.loadForTransition` :
   * ne jamais confondre une exception MÉTIER (404/400) avec une bascule en
   * mode dégradé.
   */
  private async loadCaseForMutation(id: string): Promise<{ mode: 'db'; entity: CommissionCase } | { mode: 'memory'; row: MemoryCase }> {
    try {
      const entity = await this.caseRepo.findOne({ id });
      if (entity) return { mode: 'db', entity };
    } catch (err) {
      logDegraded('CommissionService.loadCaseForMutation', `base de données injoignable (${(err as Error).message}) — repli mémoire`);
    }
    const row = this.memoryCases.find((r) => r.id === id);
    if (row) return { mode: 'memory', row };
    throw new NotFoundException({ code: 'NOT_FOUND', message: 'Dossier de commission introuvable.' });
  }

  private statusOf(loaded: { mode: 'db'; entity: CommissionCase } | { mode: 'memory'; row: MemoryCase }): CommissionCaseStatus {
    return (loaded.mode === 'db' ? loaded.entity.status : loaded.row.status) as CommissionCaseStatus;
  }

  private partiesOf(loaded: { mode: 'db'; entity: CommissionCase } | { mode: 'memory'; row: MemoryCase }): { companyA: string; companyB: string } {
    return loaded.mode === 'db' ? loaded.entity : loaded.row;
  }

  private async persistCaseStatus(
    loaded: { mode: 'db'; entity: CommissionCase } | { mode: 'memory'; row: MemoryCase },
    status: CommissionCaseStatus,
    extra: Partial<Pick<MemoryCase, 'decidedAt' | 'decision' | 'pv'>> = {},
  ): Promise<CommissionCaseViewDto> {
    if (loaded.mode === 'db') {
      loaded.entity.status = status;
      if (extra.decidedAt) loaded.entity.decidedAt = new Date(extra.decidedAt);
      if (extra.decision) loaded.entity.decision = extra.decision;
      if (extra.pv) loaded.entity.pv = extra.pv;
      await this.caseRepo.getEntityManager().flush();
      return toCaseView(loaded.entity);
    }
    Object.assign(loaded.row, { status, ...extra });
    return toCaseViewFromMemory(loaded.row);
  }

  async deliberate(id: string): Promise<CommissionCaseViewDto> {
    const loaded = await this.loadCaseForMutation(id);
    const current = this.statusOf(loaded);
    if (!canAdvanceCaseStatus(current, 'EN_DELIBERE')) {
      throw new BadRequestException({ code: 'INVALID_TRANSITION', message: `Impossible de délibérer depuis l'état "${current}".` });
    }
    return this.persistCaseStatus(loaded, 'EN_DELIBERE');
  }

  async decide(id: string, dto: DecideCommissionDto): Promise<CommissionCaseViewDto> {
    const loaded = await this.loadCaseForMutation(id);
    const current = this.statusOf(loaded);
    if (!canAdvanceCaseStatus(current, 'PRONONCE')) {
      throw new BadRequestException({
        code: 'INVALID_TRANSITION',
        message: `Impossible de prononcer une décision depuis l'état "${current}" (délibération requise au préalable).`,
      });
    }
    const decidedAt = new Date().toISOString();
    return this.persistCaseStatus(loaded, 'PRONONCE', {
      decidedAt,
      decision: { outcome: dto.outcome as CommissionDecisionInfo['outcome'], motif: dto.motif },
    });
  }

  async penalty(id: string, dto: PenaltyDto, orderedBy: string): Promise<SanctionViewDto> {
    const loaded = await this.loadCaseForMutation(id);
    const { companyA, companyB } = this.partiesOf(loaded);
    if (!isCompanyPartyToCase(dto.companyCode, companyA, companyB)) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: `"${dto.companyCode}" n'est pas partie à ce dossier (${companyA}/${companyB}).`,
      });
    }
    return this.persistSanction({ commissionCaseId: id, companyCode: dto.companyCode, type: 'PENALITE_FINANCIERE', amount: dto.amount, reason: dto.reason, orderedBy });
  }

  async sanction(id: string, dto: SanctionOrderDto, orderedBy: string): Promise<SanctionViewDto> {
    const loaded = await this.loadCaseForMutation(id);
    const { companyA, companyB } = this.partiesOf(loaded);
    if (!isCompanyPartyToCase(dto.companyCode, companyA, companyB)) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: `"${dto.companyCode}" n'est pas partie à ce dossier (${companyA}/${companyB}).`,
      });
    }
    return this.persistSanction({ commissionCaseId: id, companyCode: dto.companyCode, type: dto.type, reason: dto.reason, orderedBy });
  }

  async pvSign(id: string, dto: PvSignDto, signedBy: string): Promise<CommissionCaseViewDto> {
    const loaded = await this.loadCaseForMutation(id);
    const current = this.statusOf(loaded);
    if (current !== 'PRONONCE') {
      throw new BadRequestException({ code: 'INVALID_TRANSITION', message: 'Le PV ne peut être signé qu’après le prononcé de la décision.' });
    }
    const pv: CommissionPvInfo = { signedBy, signedAt: new Date().toISOString(), ref: dto.ref ?? `PV-${id}` };
    return this.persistCaseStatus(loaded, current, { pv });
  }

  private async persistSanction(record: Omit<MemorySanction, 'id' | 'orderedAt'>): Promise<SanctionViewDto> {
    return withDegradedFallback(
      'CommissionService.persistSanction',
      async () => {
        const entity = this.sanctionRepo.create({
          commissionCaseId: record.commissionCaseId,
          companyCode: record.companyCode,
          type: record.type,
          amount: record.amount,
          reason: record.reason,
          orderedBy: record.orderedBy,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await this.sanctionRepo.getEntityManager().persistAndFlush(entity);
        return toSanctionView(entity);
      },
      () => {
        const row: MemorySanction = { id: randomUUID(), orderedAt: new Date().toISOString(), ...record };
        this.memorySanctions.push(row);
        return toSanctionViewFromMemory(row);
      },
    );
  }

  /** B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que les sanctions de SA compagnie, quel que soit le filtre `company` demandé (ignoré s'il désigne une autre compagnie). */
  async listSanctions(query: ListSanctionsQueryDto, user?: AuthenticatedUser): Promise<PaginatedResult<SanctionViewDto>> {
    const rows = await withDegradedFallback(
      'CommissionService.listSanctions',
      async () => {
        const all = await this.sanctionRepo.findAll({ orderBy: { orderedAt: 'DESC' } });
        return all.map(toSanctionView);
      },
      () => [...this.memorySanctions].sort((a, b) => (a.orderedAt < b.orderedAt ? 1 : -1)).map(toSanctionViewFromMemory),
    );
    const tenant = user ? resolveTenantFilter(user) : undefined;
    const effectiveCompany = tenant ?? query.company;
    const filtered = effectiveCompany ? rows.filter((r) => r.companyCode === effectiveCompany) : rows;
    return paginateArray(filtered, query.page, query.pageSize);
  }
}
