import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaginatedResult, paginateArray } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { LedgerService } from '../ledger/ledger.service';
import { RecoursService } from '../recours/recours.service';
import { CommissionCaseDto, CommissionPvViewDto, CreatePenaltyDto, CreatePvDto, CreateSanctionDto, ListCommissionCasesQueryDto, SanctionViewDto } from './dto/commission.dto';
import { CommissionPv } from './entities/commission-pv.entity';
import { Sanction, SanctionType } from './entities/sanction.entity';

/** Repli mémoire — mode dégradé (voir README "Mode dégradé"). Persistant pour la durée du process. */
const MEMORY_SANCTIONS: SanctionViewDto[] = [];
const MEMORY_PVS: CommissionPvViewDto[] = [];

function sanctionToView(s: Sanction): SanctionViewDto {
  return {
    id: s.id,
    recoursId: s.recoursId,
    targetCompany: s.targetCompany,
    type: s.type,
    amount: s.amount,
    reason: s.reason,
    orderedBy: s.orderedBy,
    orderedAt: s.orderedAt.toISOString(),
  };
}

function pvToView(p: CommissionPv): CommissionPvViewDto {
  return {
    id: p.id,
    recoursId: p.recoursId,
    motif: p.motif,
    decision: p.decision,
    signataires: p.signataires,
    status: p.status,
    signedAt: (p.signedAt ?? p.createdAt).toISOString(),
  };
}

/**
 * CommissionModule — écran 7 "Commission", B.2/B.3. La file de conciliation
 * N'EST PAS un état propre à ce module : ce sont les recours escaladés en
 * commission (`RecoursModule`, état `COMMISSION` — Art. 12) — on réutilise
 * son service public (`RecoursService.list`), jamais son entité
 * (ARCHITECTURE.md §1). Pénalités/sanctions et PV, en revanche, sont bien
 * propres à ce module et persistés ici (entités `Sanction`/`CommissionPv`).
 *
 * ⚠️ HYPOTHÈSE À VALIDER PAR LE MÉTIER : le dossier ne chiffre pas le délai
 * indicatif de délibération affiché (`scheduledAt`) une fois un recours
 * escaladé — valeur par défaut paramétrable (`COMMISSION_DELIBERATION_DELAY_DAYS`,
 * 21 jours), purement informative (n'entraîne aucune transition automatique
 * côté `RecoursModule`).
 */
@Injectable()
export class CommissionService {
  private readonly deliberationDelayDays: number;

  constructor(
    @InjectRepository(Sanction) private readonly sanctionRepo: EntityRepository<Sanction>,
    @InjectRepository(CommissionPv) private readonly pvRepo: EntityRepository<CommissionPv>,
    private readonly recours: RecoursService,
    private readonly ledger: LedgerService,
    configService: ConfigService,
  ) {
    this.deliberationDelayDays = Number(configService.get<string>('COMMISSION_DELIBERATION_DELAY_DAYS') ?? 21);
  }

  async cases(query: ListCommissionCasesQueryDto): Promise<PaginatedResult<CommissionCaseDto>> {
    const { items } = await this.recours.list({ page: 1, pageSize: 100_000, state: 'COMMISSION' });
    const rows: CommissionCaseDto[] = items.map((r) => {
      const commissionAt = r.commissionAt ?? r.requestSentAt;
      const scheduledAt = new Date(new Date(commissionAt).getTime() + this.deliberationDelayDays * 86_400_000).toISOString();
      return { id: r.id, claimId: r.claimId, from: r.from, to: r.to, amount: r.amount, commissionAt, scheduledAt };
    });
    return paginateArray(rows, query.page, query.pageSize);
  }

  async penalty(recoursId: string, dto: CreatePenaltyDto, orderedBy: string): Promise<SanctionViewDto> {
    await this.assertCaseExists(recoursId);
    const view = await this.persistSanction(recoursId, SanctionType.PENALITE, dto.targetCompany, dto.amount, dto.reason, orderedBy);
    await this.ledger.append('COMMISSION', recoursId, orderedBy, `Pénalité prononcée contre ${dto.targetCompany} (${dto.amount} DA) : ${dto.reason}`);
    return view;
  }

  async sanction(recoursId: string, dto: CreateSanctionDto, orderedBy: string): Promise<SanctionViewDto> {
    await this.assertCaseExists(recoursId);
    const view = await this.persistSanction(recoursId, SanctionType.SANCTION, dto.targetCompany, dto.amount, dto.reason, orderedBy);
    await this.ledger.append('COMMISSION', recoursId, orderedBy, `Sanction prononcée contre ${dto.targetCompany} : ${dto.reason}`);
    return view;
  }

  async listSanctions(query: ListCommissionCasesQueryDto): Promise<PaginatedResult<SanctionViewDto>> {
    const rows = await withDegradedFallback(
      'CommissionService.listSanctions',
      async () => (await this.sanctionRepo.findAll({ orderBy: { orderedAt: 'DESC' } })).map(sanctionToView),
      () => [...MEMORY_SANCTIONS].sort((a, b) => (a.orderedAt < b.orderedAt ? 1 : -1)),
    );
    return paginateArray(rows, query.page, query.pageSize);
  }

  async pvSign(recoursId: string, dto: CreatePvDto, signedBy: string): Promise<CommissionPvViewDto> {
    await this.assertCaseExists(recoursId);
    const now = new Date();
    const view = await withDegradedFallback(
      'CommissionService.pvSign',
      async () => {
        const entity = this.pvRepo.create({
          recoursId,
          motif: dto.motif,
          decision: dto.decision,
          signataires: dto.signataires,
          status: 'SIGNE',
          signedAt: now,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await this.pvRepo.getEntityManager().persistAndFlush(entity);
        return pvToView(entity);
      },
      () => {
        const row: CommissionPvViewDto = {
          id: `pv-${MEMORY_PVS.length + 1}-${Date.now()}`,
          recoursId,
          motif: dto.motif,
          decision: dto.decision,
          signataires: dto.signataires,
          status: 'SIGNE',
          signedAt: now.toISOString(),
        };
        MEMORY_PVS.push(row);
        return row;
      },
    );
    await this.ledger.append('COMMISSION', recoursId, signedBy, `PV de commission signé par ${dto.signataires.join(', ')}`);
    return view;
  }

  private async assertCaseExists(recoursId: string): Promise<void> {
    await this.recours.get(recoursId); // 404 normalisé si inconnu (visibilité "place" : CommissionModule n'est pas scopé tenant)
  }

  private async persistSanction(
    recoursId: string,
    type: SanctionType,
    targetCompany: string,
    amount: number | undefined,
    reason: string,
    orderedBy: string,
  ): Promise<SanctionViewDto> {
    return withDegradedFallback(
      'CommissionService.persistSanction',
      async () => {
        const entity = this.sanctionRepo.create({
          recoursId,
          type,
          targetCompany,
          amount,
          reason,
          orderedBy,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await this.sanctionRepo.getEntityManager().persistAndFlush(entity);
        return sanctionToView(entity);
      },
      () => {
        const row: SanctionViewDto = {
          id: `snc-${MEMORY_SANCTIONS.length + 1}-${Date.now()}`,
          recoursId,
          targetCompany,
          type,
          amount,
          reason,
          orderedBy,
          orderedAt: new Date().toISOString(),
        };
        MEMORY_SANCTIONS.push(row);
        return row;
      },
    );
  }
}
