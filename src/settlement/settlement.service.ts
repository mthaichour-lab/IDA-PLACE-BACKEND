import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { assertCompanyAccess, resolveTenantFilter } from '../common/rbac/tenant-scope';
import { RecoursService } from '../recours/recours.service';
import {
  Annexe7Dto,
  CompanyMonthlySynthesisDto,
  MonthlySettlementDto,
  MonthlySummaryDto,
  QuarterlyMatrixDto,
  QuarterlySettlementDto,
  QuarterlySummaryDto,
} from './dto/settlement.dto';
import { SettlementClosure, SettlementScope } from './entities/settlement-closure.entity';
import {
  computeBilateralMatrix,
  computeBilateralNetPositions,
  computeDirectionalPairs,
  computeInsertionDeadline,
  computeMultilateralNetPositions,
  isIsoDateInMonth,
  isIsoDateInQuarter,
  parsePeriodMonth,
  PeriodMonth,
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
 * ⚠️ CONVENTION DE REGROUPEMENT MENSUEL — CORRIGÉE (verdict Product Owner,
 * voir HANDOFF.md) : `monthly()` regroupait jusqu'ici les recours par mois
 * d'ENVOI (`requestSentAt`), ce qui NE correspondait PAS à la capture de
 * référence du guide illustré (colonnes "Réglé le"/"Inséré le", sous-titre
 * "Saisie des recours réglés au plus tard le 5e jour ouvré de M+1"). Le PO a
 * confirmé qu'il s'agissait d'un vrai bug de convention (pas juste une
 * hypothèse à trancher) : `monthly()` regroupe désormais par mois de
 * RÈGLEMENT (`settledAt`, repli `requestSentAt` si absent — même filet de
 * sécurité que `quarter()`/`settledAndMatrixFor()` ci-dessous), toujours par
 * compagnie DEMANDERESSE (`from`). C'est un changement de VALEUR (quels
 * recours entrent dans le mois), PAS de FORME — `MonthlySettlementDto`/
 * `CompanyMonthlySynthesisDto` ne changent pas (contrat figé intact).
 *
 * ⚠️ RG-06 — CORRIGÉE (même verdict PO) : `monthly()` exclut désormais du
 * calcul par compagnie (`claimsCount`/`resolvedCount`/`totalAmount`) tout
 * recours actuellement à l'état `OPPOSITION` — une opposition en cours sort
 * le dossier du circuit du lot mensuel (RG-06), ce n'était pas appliqué
 * avant (seul le nouvel endpoint `monthlySummary()` l'affichait en KPI
 * d'exclusion, sans que `monthly()` lui-même n'exclue réellement ces
 * dossiers de ses propres totaux).
 *
 * Les deux endpoints ADDITIFS `monthlySummary()`/`annexe7()` (`GET
 * /settlement/monthly/:period/summary` et `.../annexe7`, écran 5 du guide
 * illustré) suivent la MÊME convention de règlement que `monthly()`
 * ci-dessus (plus de divergence depuis la correction PO) ; la compensation
 * trimestrielle (`quarter()`/`matrix()`/`summary()`) utilise elle aussi la
 * date de règlement avec le même repli, de façon indépendante.
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

  /**
   * B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que la ligne de SA
   * compagnie, jamais le bordereau des concurrentes ; les rôles "place"
   * voient tout. Comblé en revue Product Owner, sprint 3 — absent jusqu'ici.
   *
   * Regroupement par mois de RÈGLEMENT (`settledAt`, repli `requestSentAt`)
   * et exclusion RG-06 des recours en `OPPOSITION` — corrections confirmées
   * par le Product Owner, voir l'en-tête de cette classe.
   */
  async monthly(period: string, user?: AuthenticatedUser): Promise<MonthlySettlementDto> {
    const parsed = this.parseMonthOrThrow(period);
    const [allRecours, closures] = await Promise.all([this.recours.listAll(), this.findClosures(SettlementScope.MONTHLY, period)]);
    const inPeriod = allRecours.filter((r) => r.state !== 'OPPOSITION' && isIsoDateInMonth(r.settledAt ?? r.requestSentAt, parsed));

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

  /** Revue sécurité 2026-10-18 (B.7) : `assertCompanyAccess` ajouté — avant, `companyCode` venait du corps de la requête sans vérification, donc un `TRESORIER`/`CORRESPONDANT_IDA` (tous deux porteurs du privilège `synth`) pouvait clôturer la synthèse mensuelle d'une AUTRE compagnie. */
  async closeMonthly(period: string, companyCode: string, closedBy: string, user: AuthenticatedUser): Promise<CompanyMonthlySynthesisDto> {
    assertCompanyAccess(user, companyCode);
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

  /**
   * Recours RÉGLÉS du mois `period`, sur leur date de RÈGLEMENT si connue,
   * sinon leur date d'envoi (repli — même convention que `monthly()`
   * ci-dessus depuis la correction PO, voir l'en-tête de cette classe) —
   * factorisé entre `monthlySummary()` et `annexe7()` pour ne calculer
   * qu'une fois par appel.
   */
  private async settledForMonth(period: string): Promise<{ parsed: PeriodMonth; settled: Awaited<ReturnType<RecoursService['listAll']>> }> {
    const parsed = this.parseMonthOrThrow(period);
    const allRecours = await this.recours.listAll();
    const settled = allRecours.filter((r) => r.state === 'REGLE' && isIsoDateInMonth(r.settledAt ?? r.requestSentAt, parsed));
    return { parsed, settled };
  }

  /**
   * KPI de synthèse du cycle mensuel (écran 5, guide illustré) — endpoint
   * additif (`GET /settlement/monthly/:period/summary`),
   * `MonthlySettlementDto` ne change pas de forme (contrat figé).
   *
   * B.7 — `settledCount`/`totalAmount` suivent la MÊME convention de
   * scoping tenant que `monthly()` existant : un `CORRESPONDANT_IDA`/
   * `TRESORIER` ne voit que les recours dont SA compagnie est la compagnie
   * demanderesse (`from`), cohérente avec le regroupement de `monthly()`
   * (voir son en-tête). `excludedOppositionCount`, en revanche, suit le
   * même raisonnement que `opposedCount` de `summary()` (trimestre) : une
   * opposition peut être levée par l'une ou l'autre partie (`from` OU
   * `to`), et exclut le dossier du circuit quelle que soit la période —
   * donc toutes périodes confondues, place entière filtrée par `from` OU
   * `to`.
   */
  async monthlySummary(period: string, user?: AuthenticatedUser): Promise<MonthlySummaryDto> {
    const [{ parsed, settled }, allRecours] = await Promise.all([this.settledForMonth(period), this.recours.listAll()]);
    const tenant = user ? resolveTenantFilter(user) : undefined;

    const settledForTenant = tenant ? settled.filter((r) => r.from === tenant) : settled;
    const totalAmount = settledForTenant.reduce((sum, r) => sum + r.amount, 0);

    const opposed = allRecours.filter((r) => r.state === 'OPPOSITION' && (!tenant || r.from === tenant || r.to === tenant));

    return {
      period,
      settledCount: settledForTenant.length,
      totalAmount,
      excludedOppositionCount: opposed.length,
      insertionDeadline: computeInsertionDeadline(parsed),
    };
  }

  /**
   * Synthèse Annexe 7 — créanciers/débiteurs du cycle mensuel (écran 5,
   * guide illustré) : endpoint additif (`GET
   * /settlement/monthly/:period/annexe7`). Regroupe les recours réglés du
   * mois par paire orientée (from, to) EXACTE, SANS netting (voir
   * `computeDirectionalPairs` dans `settlement.rules.ts`) — une ligne
   * CAAT→SAA et une ligne SAA→CAAT distinctes si les deux existent,
   * contrairement au netting bilatéral de `/settlement/quarter`. Même
   * scoping tenant que `monthlySummary()` (filtre par compagnie
   * demanderesse `from`, cohérent avec `monthly()`).
   */
  async annexe7(period: string, user?: AuthenticatedUser): Promise<Annexe7Dto> {
    const { settled } = await this.settledForMonth(period);
    const tenant = user ? resolveTenantFilter(user) : undefined;
    const settledForTenant = tenant ? settled.filter((r) => r.from === tenant) : settled;

    const pairs = computeDirectionalPairs(settledForTenant.map((r) => ({ from: r.from, to: r.to, amount: r.amount })));
    return { period, pairs };
  }

  /**
   * Recours RÉGLÉS de ce trimestre (B.2/B.3 : "à partir des Recours
   * réglés"), sur leur date de règlement si connue, sinon leur date d'envoi
   * (hypothèse documentée) + la matrice brute qui en découle — factorisé
   * entre `quarter()`, `matrix()` et `summary()` pour ne calculer qu'une
   * fois par appel.
   */
  private async settledAndMatrixFor(q: string): Promise<{ parsed: ReturnType<typeof parsePeriodQuarter>; settled: Awaited<ReturnType<RecoursService['listAll']>>; matrix: ReturnType<typeof computeBilateralMatrix> }> {
    const parsed = this.parseQuarterOrThrow(q);
    const allRecours = await this.recours.listAll();
    const settled = allRecours.filter((r) => r.state === 'REGLE' && isIsoDateInQuarter(r.settledAt ?? r.requestSentAt, parsed));
    const matrix = computeBilateralMatrix(settled.map((r) => ({ from: r.from, to: r.to, amount: r.amount })));
    return { parsed, settled, matrix };
  }

  /** B.7 — un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que les positions où sa compagnie est partie, et uniquement son propre net — jamais la matrice complète entre concurrentes. Le net global reste calculé sur l'ensemble des positions avant filtrage (sinon le net de la compagnie serait faux). Comblé en revue Product Owner, sprint 3. */
  async quarter(q: string, user?: AuthenticatedUser): Promise<QuarterlySettlementDto> {
    const [{ matrix }, closures] = await Promise.all([this.settledAndMatrixFor(q), this.findClosures(SettlementScope.QUARTERLY, q)]);
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

  /**
   * Matrice BRUTE créancier×débiteur (avant tout netting) — pour la
   * visualisation en carte thermique (écran 6, guide illustré). Endpoint
   * additif (`GET /settlement/quarter/:q/matrix`), `QuarterlySettlementDto`
   * ne change pas de forme (contrat figé). Même scoping tenant que
   * `quarter()` : un `CORRESPONDANT_IDA`/`TRESORIER` ne voit que les
   * cellules où sa compagnie est partie.
   */
  async matrix(q: string, user?: AuthenticatedUser): Promise<QuarterlyMatrixDto> {
    const { matrix } = await this.settledAndMatrixFor(q);
    const tenant = user ? resolveTenantFilter(user) : undefined;

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

  /**
   * KPI de synthèse (écran 6, guide illustré) — endpoint additif
   * (`GET /settlement/quarter/:q/summary`), `QuarterlySettlementDto` ne
   * change pas de forme. `opposedCount` est volontairement hors période
   * (toutes les oppositions EN COURS, place entière) : une opposition en
   * cours exclut le recours du circuit de compensation quel que soit le
   * trimestre où elle a été levée — ce n'est pas une mesure "de la
   * période", mais l'état actuel du circuit.
   */
  async summary(q: string, user?: AuthenticatedUser): Promise<QuarterlySummaryDto> {
    const [{ settled, matrix }, allRecours] = await Promise.all([this.settledAndMatrixFor(q), this.recours.listAll()]);
    const tenant = user ? resolveTenantFilter(user) : undefined;

    const settledForTenant = tenant ? settled.filter((r) => r.from === tenant || r.to === tenant) : settled;
    const grossTotal = settledForTenant.reduce((sum, r) => sum + r.amount, 0);

    const allPositions = computeBilateralNetPositions(matrix);
    const positions = tenant ? allPositions.filter((p) => p.from === tenant || p.to === tenant) : allPositions;
    const bilateralNetTotal = positions.reduce((sum, p) => sum + p.amount, 0);

    const allNet = computeMultilateralNetPositions(matrix);
    const net = tenant ? allNet.filter((n) => n.code === tenant) : allNet;
    const multilateralNetTotal = net.filter((n) => n.net > 0).reduce((sum, n) => sum + n.net, 0);

    const reductionPct = grossTotal === 0 ? 0 : Math.round((1 - multilateralNetTotal / grossTotal) * 1000) / 10;

    const opposed = allRecours.filter((r) => r.state === 'OPPOSITION' && (!tenant || r.from === tenant || r.to === tenant));

    return {
      quarter: q,
      grossTotal,
      bilateralNetTotal,
      multilateralNetTotal,
      reductionPct,
      settledCount: settledForTenant.length,
      opposedCount: opposed.length,
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
