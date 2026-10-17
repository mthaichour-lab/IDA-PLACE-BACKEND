import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { resolveTenantFilter } from '../common/rbac/tenant-scope';
import { RecoursService } from '../recours/recours.service';
import {
  CompanyMonthlySynthesisDto,
  MonthlySettlementDto,
  QuarterlySettlementDto,
} from './dto/settlement.dto';
import { SettlementClosure, SettlementScope } from './entities/settlement-closure.entity';
import {
  computeBilateralMatrix,
  computeBilateralNetPositions,
  computeMultilateralNetPositions,
  isIsoDateInMonth,
  isIsoDateInQuarter,
  parsePeriodMonth,
  parsePeriodQuarter,
} from './settlement.rules';

const RESOLVED_STATES = new Set(['REGLE', 'REJETE', 'FORCLOS']);

interface ClosureRecord {
  scope: SettlementScope;
  period: string;
  companyCode?: string;
  bordereauRef: string;
  closedAt: string;
  closedBy: string;
}

/**
 * SettlementModule — B.2/B.3, écrans 5 "Cycle mensuel" et 6 "Compensation
 * trimestrielle". Dépend de `RecoursModule` (lecture seule, interface
 * publique `RecoursService.listAll()` — jamais l'entité `Recours`) pour
 * calculer, à partir des recours réellement enregistrés :
 *  - la synthèse mensuelle par compagnie (écran 5) ;
 *  - la compensation multilatérale trimestrielle (écran 6, à partir des
 *    recours RÉGLÉS uniquement — voir `settlement.rules.ts`).
 *
 * ⚠️ HYPOTHÈSE documentée (voir HANDOFF.md) : la synthèse mensuelle regroupe
 * les recours par mois d'ENVOI (`requestSentAt`) et par compagnie
 * DEMANDERESSE (`from`) — le dossier technique ne précise pas cette
 * convention ; la compensation trimestrielle utilise la date de règlement
 * (`settledAt`) si connue, sinon `requestSentAt` en repli.
 */
@Injectable()
export class SettlementService {
  private readonly memoryClosures: ClosureRecord[] = [];

  constructor(
    @InjectRepository(SettlementClosure) private readonly closureRepo: EntityRepository<SettlementClosure>,
    private readonly recours: RecoursService,
  ) {}

  private parseMonthOrThrow(period: string) {
    try {
      return parsePeriodMonth(period);
    } catch (err) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: (err as Error).message });
    }
  }

  private parseQuarterOrThrow(q: string) {
    try {
      return parsePeriodQuarter(q);
    } catch (err) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: (err as Error).message });
    }
  }

  private async findClosures(scope: SettlementScope, period: string): Promise<ClosureRecord[]> {
    return withDegradedFallback(
      'SettlementService.findClosures',
      async () => {
        const rows = await this.closureRepo.find({ scope, period });
        return rows.map((r) => ({
          scope: r.scope,
          period: r.period,
          companyCode: r.companyCode,
          bordereauRef: r.bordereauRef,
          closedAt: r.closedAt.toISOString(),
          closedBy: r.closedBy,
        }));
      },
      () => this.memoryClosures.filter((c) => c.scope === scope && c.period === period),
    );
  }

  private async persistClosure(record: Omit<ClosureRecord, 'closedAt'>): Promise<ClosureRecord> {
    const closedAt = new Date().toISOString();
    return withDegradedFallback(
      'SettlementService.persistClosure',
      async () => {
        const entity = this.closureRepo.create({
          scope: record.scope,
          period: record.period,
          companyCode: record.companyCode,
          bordereauRef: record.bordereauRef,
          closedBy: record.closedBy,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await this.closureRepo.getEntityManager().persistAndFlush(entity);
        return { ...record, closedAt: entity.closedAt.toISOString() };
      },
      () => {
        const row: ClosureRecord = { ...record, closedAt };
        this.memoryClosures.push(row);
        return row;
      },
    );
  }

  /** B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que la ligne de SA compagnie, jamais le bordereau des concurrentes ; les rôles "place" voient tout. Comblé en revue Product Owner, sprint 3 — absent jusqu'ici. */
  async monthly(period: string, user?: AuthenticatedUser): Promise<MonthlySettlementDto> {
    const parsed = this.parseMonthOrThrow(period);
    const [allRecours, closures] = await Promise.all([this.recours.listAll(), this.findClosures(SettlementScope.MONTHLY, period)]);
    const inPeriod = allRecours.filter((r) => isIsoDateInMonth(r.requestSentAt, parsed));

    const byCompany = new Map<string, { claimsCount: number; resolvedCount: number; totalAmount: number }>();
    for (const r of inPeriod) {
      const bucket = byCompany.get(r.from) ?? { claimsCount: 0, resolvedCount: 0, totalAmount: 0 };
      bucket.claimsCount += 1;
      bucket.totalAmount += r.amount;
      if (RESOLVED_STATES.has(r.state)) bucket.resolvedCount += 1;
      byCompany.set(r.from, bucket);
    }

    const tenant = user ? resolveTenantFilter(user) : undefined;

    const companies: CompanyMonthlySynthesisDto[] = Array.from(byCompany.entries())
      .filter(([code]) => !tenant || code === tenant)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, b]) => {
        const closure = closures.find((c) => c.companyCode === code);
        return {
          code,
          claimsCount: b.claimsCount,
          resolvedCount: b.resolvedCount,
          totalAmount: b.totalAmount,
          status: closure ? 'CLOTURE' : 'EN_COURS',
          closedAt: closure?.closedAt,
          bordereauRef: closure?.bordereauRef,
        };
      });

    return { period, companies };
  }

  async closeMonthly(period: string, companyCode: string, closedBy: string): Promise<CompanyMonthlySynthesisDto> {
    this.parseMonthOrThrow(period);
    const existing = await this.findClosures(SettlementScope.MONTHLY, period);
    if (existing.some((c) => c.companyCode === companyCode)) {
      throw new ConflictException({ code: 'ALREADY_CLOSED', message: `Synthèse mensuelle ${period} déjà clôturée pour ${companyCode}.` });
    }
    await this.persistClosure({
      scope: SettlementScope.MONTHLY,
      period,
      companyCode,
      bordereauRef: `BORD-M-${period}-${companyCode}`,
      closedBy,
    });
    const result = await this.monthly(period);
    const company = result.companies.find((c) => c.code === companyCode);
    return (
      company ?? {
        code: companyCode,
        claimsCount: 0,
        resolvedCount: 0,
        totalAmount: 0,
        status: 'CLOTURE',
        bordereauRef: `BORD-M-${period}-${companyCode}`,
      }
    );
  }

  /** B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que les positions où sa compagnie est partie, et uniquement son propre net — jamais la matrice complète entre concurrentes. Le net global reste calculé sur l'ensemble des positions avant filtrage (sinon le net de la compagnie serait faux). Comblé en revue Product Owner, sprint 3. */
  async quarter(q: string, user?: AuthenticatedUser): Promise<QuarterlySettlementDto> {
    const parsed = this.parseQuarterOrThrow(q);
    const [allRecours, closures] = await Promise.all([this.recours.listAll(), this.findClosures(SettlementScope.QUARTERLY, q)]);

    // Compensation trimestrielle : uniquement les recours RÉGLÉS (B.2/B.3
    // de la mission : "à partir des Recours réglés"), sur leur date de
    // règlement si connue, sinon leur date d'envoi (hypothèse documentée).
    const settled = allRecours.filter((r) => r.state === 'REGLE' && isIsoDateInQuarter(r.settledAt ?? r.requestSentAt, parsed));
    const matrix = computeBilateralMatrix(settled.map((r) => ({ from: r.from, to: r.to, amount: r.amount })));
    const allPositions = computeBilateralNetPositions(matrix);
    const allNet = computeMultilateralNetPositions(matrix);
    const closure = closures[0];

    const tenant = user ? resolveTenantFilter(user) : undefined;
    const positions = tenant ? allPositions.filter((p) => p.from === tenant || p.to === tenant) : allPositions;
    const net = tenant ? allNet.filter((n) => n.code === tenant) : allNet;

    return {
      quarter: q,
      bordereau: closure?.bordereauRef,
      positions,
      net,
      closedAt: closure?.closedAt,
      closedBy: closure?.closedBy,
    };
  }

  async closeQuarterly(q: string, closedBy: string): Promise<QuarterlySettlementDto> {
    this.parseQuarterOrThrow(q);
    const existing = await this.findClosures(SettlementScope.QUARTERLY, q);
    if (existing.length > 0) {
      throw new ConflictException({ code: 'ALREADY_CLOSED', message: `Compensation trimestrielle ${q} déjà clôturée.` });
    }
    await this.persistClosure({ scope: SettlementScope.QUARTERLY, period: q, bordereauRef: `BORD-Q-${q}`, closedBy });
    return this.quarter(q);
  }
}
