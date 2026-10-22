import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { CLOCK, Clock, systemClock } from '../common/clock';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { assertCompanyAccess, resolveTenantFilter } from '../common/rbac/tenant-scope';
import { LedgerService } from '../ledger/ledger.service';
import { RecoursViewDto } from '../recours/dto/recours.dto';
import { sumAmounts } from '../recours/money';
import { assertPlaceUser, isPlaceUser } from '../recours/place-role';
import { RecoursService } from '../recours/recours.service';
import { isUniqueViolation, withStrictFallback } from '../recours/strict-persistence';
import {
  Annexe7Dto,
  CompanyMonthlySynthesisDto,
  MonthlySettlementDto,
  MonthlySummaryDto,
  QuarterlyClosureDto,
  QuarterlyMatrixDto,
  QuarterlySettlementDto,
  QuarterlySummaryDto,
} from './dto/settlement.dto';
import { SettlementClosure, SettlementScope } from './entities/settlement-closure.entity';
import {
  BilateralMatrix,
  canonicalJson,
  computeBilateralMatrix,
  computeBilateralNetPositions,
  computeDirectionalPairs,
  computeInsertionDeadline,
  computeMultilateralNetPositions,
  isIsoDateInMonth,
  isIsoDateInQuarter,
  isPeriodElapsed,
  lastDayOfMonth,
  lastDayOfQuarter,
  parsePeriodMonth,
  PeriodMonth,
  parsePeriodQuarter,
  PeriodQuarter,
} from './settlement.rules';

/** Ligne d'un instantané de clôture : le recours tel qu'il a été compensé. */
interface SnapshotRecours {
  id: string;
  from: string;
  to: string;
  amount: number;
  settledAt?: string;
}

interface QuarterlySnapshot {
  quarter: string;
  recours: SnapshotRecours[];
  matrix: BilateralMatrix;
}

interface MonthlySnapshot {
  period: string;
  company: string;
  recours: SnapshotRecours[];
  claimsCount: number;
  resolvedCount: number;
  totalAmount: number;
}

interface ClosureRecord {
  scope: SettlementScope;
  period: string;
  companyCode?: string;
  bordereauRef: string;
  closedAt: string;
  closedBy: string;
  closedById?: string;
  snapshot?: Record<string, unknown>;
  snapshotHash?: string;
}

function closureOf(r: SettlementClosure): ClosureRecord {
  return {
    scope: r.scope,
    period: r.period,
    companyCode: r.companyCode,
    bordereauRef: r.bordereauRef,
    closedAt: r.closedAt.toISOString(),
    closedBy: r.closedBy,
    closedById: r.closedById,
    snapshot: r.snapshot,
    snapshotHash: r.snapshotHash,
  };
}

function snapshotLine(r: RecoursViewDto): SnapshotRecours {
  return { id: r.id, from: r.from, to: r.to, amount: r.amount, settledAt: r.settledAt };
}

function hashSnapshot(snapshot: unknown): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

const ALREADY_CLOSED = (message: string) => new ConflictException({ code: 'ALREADY_CLOSED', message });

/**
 * SettlementModule — B.2/B.3, écrans 5 "Cycle mensuel" et 6 "Compensation
 * trimestrielle". Dépend de `RecoursModule` (lecture seule, interface
 * publique `RecoursService.listAll()` — jamais l'entité `Recours`).
 *
 * Revue sécurité 2026-10-19 :
 *  - SEC-34 : montants en centimes (voir `settlement.rules.ts`) ; la synthèse
 *    mensuelle ne retient plus QUE les recours RÉGLÉS (`REGLE`), par mois de
 *    règlement (`settledAt`) — avant, un recours non réglé y entrait au mois
 *    de son envoi puis, une fois réglé, au mois de son règlement : compté
 *    deux fois. `claimsCount`/`resolvedCount` dénombrent donc les recours
 *    réglés du mois ;
 *  - SEC-19 : une clôture est unique (index unique en base, 409), refusée
 *    tant que la période n'est pas échue, et fige un INSTANTANÉ (recours
 *    retenus, matrice) dont le hash est scellé au journal ; les lectures d'une
 *    période close renvoient cet instantané, plus un recalcul ; plus aucun
 *    repli mémoire en production (503) ;
 *  - SEC-25 : clôture trimestrielle réservée aux rôles place, même avec un privilège obtenu par dérogation ;
 *  - SEC-26 : auteurs (`closedBy`) jamais renvoyés aux rôles compagnie.
 */
@Injectable()
export class SettlementService {
  private readonly memoryClosures: ClosureRecord[] = [];
  private readonly now: Clock;

  constructor(
    @InjectRepository(SettlementClosure) private readonly closureRepo: EntityRepository<SettlementClosure>,
    private readonly recours: RecoursService,
    @Optional() private readonly ledger?: LedgerService,
    @Optional() @Inject(CLOCK) clock?: Clock,
  ) {
    this.now = clock ?? systemClock;
  }

  private parseMonthOrThrow(period: string): PeriodMonth {
    try {
      return parsePeriodMonth(period);
    } catch (err) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: (err as Error).message });
    }
  }

  private parseQuarterOrThrow(q: string): PeriodQuarter {
    try {
      return parsePeriodQuarter(q);
    } catch (err) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: (err as Error).message });
    }
  }

  /** SEC-19 : aucune clôture « oubliée » sur panne — 503 en production, repli mémoire en développement seulement. */
  private async findClosures(scope: SettlementScope, period?: string): Promise<ClosureRecord[]> {
    return withStrictFallback(
      'SettlementService.findClosures',
      async () => (await this.closureRepo.find(period ? { scope, period } : { scope })).map(closureOf),
      () => this.memoryClosures.filter((c) => c.scope === scope && (!period || c.period === period)),
    );
  }

  private async persistClosure(record: Omit<ClosureRecord, 'closedAt'>, ledgerType: string, actorId: string): Promise<ClosureRecord> {
    const closedAt = this.now();
    const summary = JSON.stringify({ scope: record.scope, period: record.period, company: record.companyCode, bordereau: record.bordereauRef, snapshotHash: record.snapshotHash });
    const conflict = () => ALREADY_CLOSED(`Période ${record.period} déjà clôturée${record.companyCode ? ` pour ${record.companyCode}` : ''}.`);
    return withStrictFallback(
      'SettlementService.persistClosure',
      async () => {
        try {
          return await (this.closureRepo.getEntityManager() as EntityManager).fork({ clear: true }).transactional(async (tem) => {
            const entity = tem.create(SettlementClosure, { ...record, closedAt } as never);
            await tem.flush();
            // Clôture et scellement dans la même transaction.
            if (this.ledger) await this.ledger.append(ledgerType, record.bordereauRef, actorId, summary);
            return closureOf(entity);
          });
        } catch (err) {
          throw isUniqueViolation(err) ? conflict() : err;
        }
      },
      async () => {
        if (this.memoryClosures.some((c) => c.scope === record.scope && c.period === record.period && (c.companyCode ?? '') === (record.companyCode ?? ''))) throw conflict();
        const row: ClosureRecord = { ...record, closedAt: closedAt.toISOString() };
        this.memoryClosures.push(row);
        if (this.ledger) await this.ledger.append(ledgerType, record.bordereauRef, actorId, summary);
        return row;
      },
    );
  }

  private tenantOf(user?: AuthenticatedUser): string | undefined {
    return user ? resolveTenantFilter(user) : undefined;
  }

  /** Recours RÉGLÉS dont le règlement tombe dans le mois (SEC-34 : une seule appartenance possible). */
  private settledInMonth(all: RecoursViewDto[], parsed: PeriodMonth): RecoursViewDto[] {
    return all.filter((r) => r.state === 'REGLE' && isIsoDateInMonth(r.settledAt ?? r.requestSentAt, parsed));
  }

  private monthlyLine(company: string, settled: RecoursViewDto[]): Omit<MonthlySnapshot, 'period' | 'company'> {
    const mine = settled.filter((r) => r.from === company).sort((a, b) => a.id.localeCompare(b.id));
    return {
      recours: mine.map(snapshotLine),
      claimsCount: mine.length,
      resolvedCount: mine.length,
      totalAmount: sumAmounts(mine.map((r) => r.amount)),
    };
  }

  /**
   * B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que la ligne de SA compagnie.
   * SEC-34 : recours RÉGLÉS uniquement, par mois de règlement. SEC-19 : une
   * ligne clôturée renvoie les montants figés à la clôture.
   */
  async monthly(period: string, user?: AuthenticatedUser): Promise<MonthlySettlementDto> {
    const parsed = this.parseMonthOrThrow(period);
    const [allRecours, closures] = await Promise.all([this.recours.listAll(), this.findClosures(SettlementScope.MONTHLY, period)]);
    const settled = this.settledInMonth(allRecours, parsed);
    const tenant = this.tenantOf(user);

    const codes = new Set<string>([...settled.map((r) => r.from), ...closures.map((c) => c.companyCode).filter((c): c is string => !!c)]);
    const companies: CompanyMonthlySynthesisDto[] = Array.from(codes)
      .filter((code) => !tenant || code === tenant)
      .sort((a, b) => a.localeCompare(b))
      .map((code) => {
        const closure = closures.find((c) => c.companyCode === code);
        const frozen = closure?.snapshot as MonthlySnapshot | undefined;
        const line = frozen ?? this.monthlyLine(code, settled);
        return {
          code,
          claimsCount: line.claimsCount,
          resolvedCount: line.resolvedCount,
          totalAmount: line.totalAmount,
          status: closure ? 'CLOTURE' : 'EN_COURS',
          closedAt: closure?.closedAt,
          bordereauRef: closure?.bordereauRef,
        };
      });

    return { period, companies };
  }

  /** Revue sécurité 2026-10-18 (B.7) : `assertCompanyAccess`. SEC-19 : période échue, unicité en base, instantané scellé. */
  async closeMonthly(period: string, companyCode: string, closedBy: string, user: AuthenticatedUser): Promise<CompanyMonthlySynthesisDto> {
    assertCompanyAccess(user, companyCode);
    const parsed = this.parseMonthOrThrow(period);
    if (!isPeriodElapsed(lastDayOfMonth(parsed), this.now())) {
      throw new ConflictException({ code: 'PERIODE_NON_ECHUE', message: `La période ${period} n'est pas échue : elle ne peut pas être clôturée.` });
    }
    const existing = await this.findClosures(SettlementScope.MONTHLY, period);
    if (existing.some((c) => c.companyCode === companyCode)) throw ALREADY_CLOSED(`Synthèse mensuelle ${period} déjà clôturée pour ${companyCode}.`);

    const settled = this.settledInMonth(await this.recours.listAll(), parsed);
    const snapshot: MonthlySnapshot = { period, company: companyCode, ...this.monthlyLine(companyCode, settled) };
    const bordereauRef = `BORD-M-${period}-${companyCode}`;
    const closure = await this.persistClosure(
      { scope: SettlementScope.MONTHLY, period, companyCode, bordereauRef, closedBy, closedById: user.id, snapshot: snapshot as unknown as Record<string, unknown>, snapshotHash: hashSnapshot(snapshot) },
      'CLOTURE_MENSUELLE',
      user.id,
    );
    return {
      code: companyCode,
      claimsCount: snapshot.claimsCount,
      resolvedCount: snapshot.resolvedCount,
      totalAmount: snapshot.totalAmount,
      status: 'CLOTURE',
      closedAt: closure.closedAt,
      bordereauRef,
    };
  }

  /** Recours RÉGLÉS du mois `period` (date de règlement) — factorisé entre `monthlySummary()` et `annexe7()`. */
  private async settledForMonth(period: string): Promise<{ parsed: PeriodMonth; settled: RecoursViewDto[] }> {
    const parsed = this.parseMonthOrThrow(period);
    return { parsed, settled: this.settledInMonth(await this.recours.listAll(), parsed) };
  }

  /** KPI de synthèse du cycle mensuel (écran 5) — même périmètre tenant que `monthly()` ; montants en centimes (SEC-34). */
  async monthlySummary(period: string, user?: AuthenticatedUser): Promise<MonthlySummaryDto> {
    const [{ parsed, settled }, allRecours] = await Promise.all([this.settledForMonth(period), this.recours.listAll()]);
    const tenant = this.tenantOf(user);
    const settledForTenant = tenant ? settled.filter((r) => r.from === tenant) : settled;
    const opposed = allRecours.filter((r) => r.state === 'OPPOSITION' && (!tenant || r.from === tenant || r.to === tenant));
    return {
      period,
      settledCount: settledForTenant.length,
      totalAmount: sumAmounts(settledForTenant.map((r) => r.amount)),
      excludedOppositionCount: opposed.length,
      insertionDeadline: computeInsertionDeadline(parsed),
    };
  }

  /** Synthèse Annexe 7 — paires orientées (from, to) sans netting, montants en centimes (SEC-34). */
  async annexe7(period: string, user?: AuthenticatedUser): Promise<Annexe7Dto> {
    const { settled } = await this.settledForMonth(period);
    const tenant = this.tenantOf(user);
    const settledForTenant = tenant ? settled.filter((r) => r.from === tenant) : settled;
    return { period, pairs: computeDirectionalPairs(settledForTenant.map((r) => ({ from: r.from, to: r.to, amount: r.amount }))) };
  }

  /**
   * Recours RÉGLÉS du trimestre et matrice brute : depuis l'INSTANTANÉ figé si
   * le trimestre est clôturé (SEC-19), sinon calculés à partir des recours.
   */
  private async settledAndMatrixFor(q: string): Promise<{ settled: SnapshotRecours[]; matrix: BilateralMatrix; closure?: ClosureRecord }> {
    const parsed = this.parseQuarterOrThrow(q);
    const [closure] = await this.findClosures(SettlementScope.QUARTERLY, q);
    const frozen = closure?.snapshot as QuarterlySnapshot | undefined;
    if (frozen) return { settled: frozen.recours, matrix: frozen.matrix, closure };
    const settled = (await this.recours.listAll()).filter((r) => r.state === 'REGLE' && isIsoDateInQuarter(r.settledAt ?? r.requestSentAt, parsed)).map(snapshotLine);
    return { settled, matrix: computeBilateralMatrix(settled), closure };
  }

  /** B.7 — un rôle compagnie ne voit que les positions où il est partie et son propre net ; SEC-26 : jamais l'auteur de la clôture. */
  async quarter(q: string, user?: AuthenticatedUser): Promise<QuarterlySettlementDto> {
    const { matrix, closure } = await this.settledAndMatrixFor(q);
    const allPositions = computeBilateralNetPositions(matrix);
    const allNet = computeMultilateralNetPositions(matrix);
    const tenant = this.tenantOf(user);
    const showAuthor = !user || isPlaceUser(user);
    return {
      quarter: q,
      bordereau: closure?.bordereauRef,
      positions: tenant ? allPositions.filter((p) => p.from === tenant || p.to === tenant) : allPositions,
      net: tenant ? allNet.filter((n) => n.code === tenant) : allNet,
      closedAt: closure?.closedAt,
      closedBy: showAuthor ? closure?.closedBy : undefined,
    };
  }

  /** Matrice BRUTE créancier×débiteur (carte thermique, écran 6) — même scoping tenant que `quarter()`. */
  async matrix(q: string, user?: AuthenticatedUser): Promise<QuarterlyMatrixDto> {
    const { matrix } = await this.settledAndMatrixFor(q);
    const tenant = this.tenantOf(user);
    const cells: { from: string; to: string; amount: number }[] = [];
    const companies = new Set<string>();
    for (const from of Object.keys(matrix)) {
      for (const to of Object.keys(matrix[from])) {
        if (tenant && from !== tenant && to !== tenant) continue;
        cells.push({ from, to, amount: matrix[from][to] });
        companies.add(from);
        companies.add(to);
      }
    }
    return { quarter: q, companies: Array.from(companies).sort(), cells };
  }

  /** KPI de synthèse du trimestre (écran 6) — sommes en centimes (SEC-34). */
  async summary(q: string, user?: AuthenticatedUser): Promise<QuarterlySummaryDto> {
    const [{ settled, matrix }, allRecours] = await Promise.all([this.settledAndMatrixFor(q), this.recours.listAll()]);
    const tenant = this.tenantOf(user);

    const settledForTenant = tenant ? settled.filter((r) => r.from === tenant || r.to === tenant) : settled;
    const grossTotal = sumAmounts(settledForTenant.map((r) => r.amount));

    const allPositions = computeBilateralNetPositions(matrix);
    const positions = tenant ? allPositions.filter((p) => p.from === tenant || p.to === tenant) : allPositions;
    const bilateralNetTotal = sumAmounts(positions.map((p) => p.amount));

    const allNet = computeMultilateralNetPositions(matrix);
    const net = tenant ? allNet.filter((n) => n.code === tenant) : allNet;
    // Place : flux réellement échangés après netting = somme des positions
    // créditrices (égale à celle des débitrices). Compagnie : SON flux net,
    // à recevoir ou à payer (valeur absolue) — sinon un débiteur net verrait
    // « 0 DA après netting, réduction 100 % ».
    const multilateralNetTotal = tenant ? sumAmounts(net.map((n) => Math.abs(n.net))) : sumAmounts(net.filter((n) => n.net > 0).map((n) => n.net));

    const reductionPct = grossTotal === 0 ? 0 : Math.round((1 - multilateralNetTotal / grossTotal) * 1000) / 10;
    const opposed = allRecours.filter((r) => r.state === 'OPPOSITION' && (!tenant || r.from === tenant || r.to === tenant));

    return { quarter: q, grossTotal, bilateralNetTotal, multilateralNetTotal, reductionPct, settledCount: settledForTenant.length, opposedCount: opposed.length };
  }

  /**
   * TOUTES les clôtures trimestrielles (écran 4, sous-onglets "Accepté/silence"
   * vs "Réglé/compensé", décision PO 2026-10-18). SEC-26 : `closedBy` (nom
   * de l'auteur) n'est renvoyé qu'aux rôles place.
   */
  async quarterlyClosures(user?: AuthenticatedUser): Promise<QuarterlyClosureDto[]> {
    const showAuthor = !user || isPlaceUser(user);
    const rows = (await this.findClosures(SettlementScope.QUARTERLY)).map((c) => ({
      period: c.period,
      closedAt: c.closedAt,
      bordereauRef: c.bordereauRef,
      ...(showAuthor ? { closedBy: c.closedBy } : {}),
    }));
    return rows.sort((a, b) => a.period.localeCompare(b.period));
  }

  /** SEC-19/SEC-25 : rôle place, trimestre échu, unicité en base, instantané (recours + matrice) haché et scellé au journal. */
  async closeQuarterly(q: string, user: AuthenticatedUser): Promise<QuarterlySettlementDto> {
    assertPlaceUser(user);
    const parsed = this.parseQuarterOrThrow(q);
    if (!isPeriodElapsed(lastDayOfQuarter(parsed), this.now())) {
      throw new ConflictException({ code: 'PERIODE_NON_ECHUE', message: `Le trimestre ${q} n'est pas échu : il ne peut pas être clôturé.` });
    }
    const existing = await this.findClosures(SettlementScope.QUARTERLY, q);
    if (existing.length > 0) throw ALREADY_CLOSED(`Compensation trimestrielle ${q} déjà clôturée.`);

    const { settled, matrix } = await this.settledAndMatrixFor(q);
    const snapshot: QuarterlySnapshot = { quarter: q, recours: [...settled].sort((a, b) => a.id.localeCompare(b.id)), matrix };
    await this.persistClosure(
      { scope: SettlementScope.QUARTERLY, period: q, bordereauRef: `BORD-Q-${q}`, closedBy: user.name, closedById: user.id, snapshot: snapshot as unknown as Record<string, unknown>, snapshotHash: hashSnapshot(snapshot) },
      'CLOTURE_TRIMESTRIELLE',
      user.id,
    );
    return this.quarter(q, user);
  }
}
