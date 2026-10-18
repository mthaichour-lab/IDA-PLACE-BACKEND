import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdherentsModule } from '../adherents/adherents.module';
import { AdherentsService } from '../adherents/adherents.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { CacheService } from '../common/cache/cache.service';
import { ClaimsModule } from '../claims/claims.module';
import { ClaimsService } from '../claims/claims.service';
import { CommissionModule } from '../commission/commission.module';
import { CommissionService } from '../commission/commission.service';
import { ExpertsModule } from '../experts/experts.module';
import { ExpertsService } from '../experts/experts.service';
import { MatchingModule } from '../matching/matching.module';
import { MatchingService } from '../matching/matching.service';
import { RecoursModule } from '../recours/recours.module';
import { RecoursService } from '../recours/recours.service';
import { SettlementModule } from '../settlement/settlement.module';
import { SettlementService } from '../settlement/settlement.service';
import { StatsModule } from '../stats/stats.module';
import { StatsService } from '../stats/stats.service';

const SUMMARY_CACHE_TTL_SECONDS = 10;

const LATE_THRESHOLD_DAYS = 7;

function currentMonthPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function currentQuarterPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
}

/**
 * CockpitModule — écran 1 "Cockpit de place". Module AGRÉGATEUR additionnel
 * (en plus des 17 modules de B.2), qui agrège les VRAIES données de TOUS les
 * modules désormais réels (Claims/Matching/Recours/Settlement/Commission/
 * Experts/Adherents/Stats). Forme de `GET /cockpit/summary` étendue de
 * manière PUREMENT ADDITIVE (2026-10-18, rapprochement du guide illustré,
 * écran 1) : `kpis`/`sparklineDeclarations`/`barresNettes`/`updatedAt`
 * INCHANGÉS (contrat stable, voir HANDOFF.md), nouveaux champs ci-dessous.
 *
 * ⚠️ "Cycle conventionnel" (guide illustré) — SEULEMENT 3 des 5 étapes
 * montrées dans la capture sont réellement suivies par ce backend (saisie
 * mensuelle Art.16, synthèse Annexe 7, clôture trimestrielle Art.17) :
 * aucune entité ne modélise la "Réunion UAR" (Art.17 convocation) ni les
 * "Règlements sous 8j" (Art.18 exécution) — pas de date de convocation, pas
 * de suivi d'exécution des virements nulle part dans ce worktree. Plutôt
 * que d'inventer des dates de convocation/limite pour ces 2 étapes, elles
 * sont absentes de `cycleConventionnel.steps` (3 étapes réelles seulement).
 *
 * "Alertes conventionnelles" — dérivées des VRAIS timers expirés
 * (`RecoursViewDto.timer.expired`, déjà calculé par `recours.rules.ts`) et
 * des VRAIS dossiers de commission en dépassement (`CommissionService`,
 * seuil Art.24 déjà réel) — jamais une alerte inventée.
 */
@ApiTags('cockpit')
@ApiBearerAuth()
@Controller('cockpit')
@UseGuards(AuthGuard, PrivilegesGuard)
class CockpitController {
  constructor(
    private readonly claims: ClaimsService,
    private readonly matching: MatchingService,
    private readonly recours: RecoursService,
    private readonly settlement: SettlementService,
    private readonly commission: CommissionService,
    private readonly experts: ExpertsService,
    private readonly adherents: AdherentsService,
    private readonly stats: StatsService,
    private readonly cache: CacheService,
  ) {}

  @Get('summary')
  @ApiOperation({ summary: 'KPIs agrégés du cockpit de place (écran 1) — mis en cache (Redis si REDIS_ENABLED, sinon recalculé à chaque appel, voir cache.service.ts)' })
  async summary() {
    return this.cache.getOrSet('cockpit:summary', SUMMARY_CACHE_TTL_SECONDS, () => this.computeSummary());
  }

  private async computeSummary() {
    const monthPeriod = currentMonthPeriod();
    const quarterPeriod = currentQuarterPeriod();

    const [
      { items: allClaims },
      matchCounters,
      allRecours,
      quarterSettlement,
      quarterSummary,
      commissionSummary,
      overdueCasesPage,
      { items: allExperts },
      { items: allCompanies },
      wilayaStats,
      monthlyStats,
    ] = await Promise.all([
      this.claims.list({ page: 1, pageSize: 100_000 }),
      this.matching.counters(),
      this.recours.listAll(),
      this.settlement.quarter(quarterPeriod),
      this.settlement.summary(quarterPeriod),
      this.commission.summary(),
      this.commission.listCases({ page: 1, pageSize: 10_000 }),
      this.experts.list(1, 10_000),
      this.adherents.listCompanies(1, 10_000),
      this.stats.wilayas(),
      this.stats.monthly(),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    const lateThresholdMs = LATE_THRESHOLD_DAYS * 86_400_000;

    // ---- kpis (contrat stable — 4 champs existants + additifs) ----
    const dossiersDuJour = allClaims.filter((c) => c.createdAt.slice(0, 10) === today).length;
    const enRetard = allClaims.filter((c) => c.state === 'A_APPARIER' && now - new Date(c.createdAt).getTime() > lateThresholdMs).length;
    const compensationAVenir = allClaims
      .filter((c) => c.state === 'A_APPARIER' || c.state === 'APPARIE')
      .reduce((sum, c) => sum + (c.expertAmount ?? c.estimatedAmount ?? 0), 0);

    const recoursTerminaux = new Set(['REGLE', 'REJETE', 'FORCLOS']);
    const recoursEnCours = allRecours.filter((r) => !recoursTerminaux.has(r.state)).length;
    const delaisDepasses = allRecours.filter((r) => r.timer.expired).length;
    const appariementAutoPct = matchCounters.TOUS > 0 ? Math.round(((matchCounters.AUTO ?? 0) / matchCounters.TOUS) * 1000) / 10 : null;

    // ---- sparkline / barresNettes (contrat stable — valeurs inchangées) ----
    const sparklineDeclarations: number[] = [];
    for (let i = 11; i >= 0; i--) {
      const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
      sparklineDeclarations.push(allClaims.filter((c) => c.createdAt.slice(0, 10) === day).length);
    }
    const companiesFromClaims = new Set<string>();
    for (const c of allClaims) {
      if (c.company) companiesFromClaims.add(c.company);
      if (c.counterpartyCompany) companiesFromClaims.add(c.counterpartyCompany);
    }
    const barresNettes = Array.from(companiesFromClaims).map((company) => {
      const net = allClaims.reduce((sum, c) => {
        const amount = c.expertAmount ?? c.estimatedAmount ?? 0;
        if (c.company === company) return sum + amount;
        if (c.counterpartyCompany === company) return sum - amount;
        return sum;
      }, 0);
      return { company, net };
    });

    // ---- indicateursDePlace (additif, 10 tuiles écran 1) ----
    const declarationsDuMois = allClaims.filter((c) => c.createdAt.slice(0, 7) === monthPeriod).length;
    const horsIdaCount = allClaims.filter((c) => c.eligibilityVerdict === 'HORS_IDA').length;
    const tauxHorsIdaPct = allClaims.length > 0 ? Math.round((horsIdaCount / allClaims.length) * 1000) / 10 : null;
    const recoursForclos = allRecours.filter((r) => r.state === 'FORCLOS').length;
    const expertsActifs = allExperts.filter((e) => e.status === 'ACTIF').length;
    const expertsSuspendus = allExperts.filter((e) => e.status === 'SUSPENDU').length;
    const adherentsActifs = allCompanies.filter((c) => c.status === 'ACTIF').length;
    const adherentsSuspendus = allCompanies.filter((c) => c.status === 'SUSPENDU').length;
    const penalitesDeRetard = (await this.commission.listSanctions({ page: 1, pageSize: 10_000 })).items
      .filter((s) => s.type === 'PENALITE_FINANCIERE')
      .reduce((sum, s) => sum + (s.amount ?? 0), 0);

    // Délai moyen d'appariement (jours) — UNIQUEMENT les appariements
    // confirmés MANUELLEMENT (`confirmedAt` posé par `decide()`, voir
    // matching.service.ts) : la confirmation AUTO ne pose PAS `confirmedAt`
    // (seul `status`/`level` changent au recalcul périodique, aucun
    // horodatage dédié n'existe pour "l'instant de l'auto-confirmation") —
    // inclure les matches AUTO ici produirait un dénominateur quasi toujours
    // vide ou un horodatage trompeur. Écart mesuré vs `at` (réception de la
    // file de confrontation, B.5) — réel, jamais une moyenne inventée.
    const toutesFile = await this.matching.queue({ filter: 'TOUS', page: 1, pageSize: 10_000 });
    const delaisAppariement = toutesFile.items
      .filter((m) => m.status === 'CONFIRME_MANUEL' && m.confirmedAt)
      .map((m) => (new Date(m.confirmedAt!).getTime() - new Date(m.at).getTime()) / 86_400_000)
      .filter((d) => d >= 0);
    const delaiMoyenAppariementJours =
      delaisAppariement.length > 0 ? Math.round((delaisAppariement.reduce((s, d) => s + d, 0) / delaisAppariement.length) * 10) / 10 : null;

    const indicateursDePlace = {
      declarationsDuMois,
      tauxAppariementPct: appariementAutoPct,
      enAttenteAppariement: matchCounters.A_CONFIRMER ?? 0,
      tauxHorsIdaPct,
      delaiMoyenAppariementJours,
      recoursForclos,
      compensationNetteT3: quarterSummary.bilateralNetTotal,
      penalitesDeRetard,
      expertsActifs,
      expertsSuspendus,
      adherentsActifs,
      adherentsSuspendus,
    };

    // ---- positionsNettesQuarter (additif) — remplace la position nette
    // basée sur les claims par la VRAIE compensation trimestrielle
    // (SettlementModule, déjà réelle depuis le sprint 3), plus précise que
    // `barresNettes` ci-dessus (conservé pour compatibilité, voir doc de
    // classe). ----
    const positionsNettesQuarter = { quarter: quarterPeriod, positions: quarterSettlement.net, grossTotal: quarterSummary.grossTotal, reductionPct: quarterSummary.reductionPct };

    // ---- monthlyDeclarations / topWilayas (additif, réutilise StatsService) ----
    const monthlyDeclarations = monthlyStats.slice(-10).map((m) => ({ month: m.month, declarations: m.declarations }));
    const topWilayas = [...wilayaStats]
      .sort((a, b) => b.declarations - a.declarations)
      .slice(0, 3)
      .map((w) => ({ code: w.code, name: w.name, declarations: w.declarations }));

    // ---- cycleConventionnel (additif, 3 étapes RÉELLES — voir doc de classe) ----
    const monthlySummaryData = await this.settlement.monthlySummary(monthPeriod).catch(() => null);
    const annexe7Data = await this.settlement.annexe7(monthPeriod).catch(() => null);
    const cycleConventionnel = {
      period: monthPeriod,
      quarter: quarterPeriod,
      steps: [
        {
          key: 'saisie',
          label: 'Saisie mensuelle',
          article: 'Art. 16',
          done: !!monthlySummaryData,
          detail: monthlySummaryData ? `Échéance ${monthlySummaryData.insertionDeadline} (jour calendaire)` : undefined,
        },
        {
          key: 'synthese_annexe7',
          label: 'Synthèse Annexe 7',
          article: 'Art. 16',
          done: !!annexe7Data && annexe7Data.pairs.length > 0,
          detail: annexe7Data ? `${annexe7Data.pairs.length} paire(s) créancier/débiteur` : undefined,
        },
        {
          key: 'cloture_trimestre',
          label: 'Compensation trimestrielle',
          article: 'Art. 17',
          done: !!quarterSettlement.closedAt,
          detail: quarterSettlement.closedAt ? `Clôturé le ${quarterSettlement.closedAt.slice(0, 10)}` : 'Non clôturé',
        },
      ],
    };

    // ---- alertesConventionnelles (additif, dérivées de VRAIS dépassements) ----
    type Alert = { id: string; from: string; to: string; description: string; article: string; detectedAt: string };
    const alertesConventionnelles: Alert[] = [];
    for (const r of allRecours) {
      if (r.timer.expired) {
        alertesConventionnelles.push({
          id: `recours-${r.id}`,
          from: r.from,
          to: r.to,
          description:
            r.timer.timerType === 'SILENCE_ART10'
              ? 'Délai de réponse Art.10 dépassé'
              : r.timer.timerType === 'OPPOSITION_ART12'
                ? 'Délai de traitement de l’opposition Art.12 dépassé'
                : 'Délai de forclusion Art.19 dépassé',
          article: r.timer.timerType === 'SILENCE_ART10' ? 'Art. 10' : r.timer.timerType === 'OPPOSITION_ART12' ? 'Art. 12' : 'Art. 19',
          detectedAt: r.timer.deadlineAt ?? r.requestSentAt,
        });
      }
    }
    for (const c of overdueCasesPage.items) {
      if (c.status === 'PRONONCE') continue;
      const ageMs = now - new Date(c.createdAt).getTime();
      if (ageMs > 15 * 86_400_000) {
        alertesConventionnelles.push({
          id: `commission-${c.id}`,
          from: c.companyA,
          to: c.companyB,
          description: 'Conciliation par la Commission — dépassement du délai Art.24',
          article: 'Art. 24',
          detectedAt: c.createdAt,
        });
      }
    }
    alertesConventionnelles.sort((a, b) => a.detectedAt.localeCompare(b.detectedAt));

    return {
      kpis: {
        dossiersDuJour,
        aApparier: matchCounters.A_CONFIRMER ?? 0,
        enRetard,
        compensationAVenir,
        recoursEnCours,
        delaisDepasses,
        appariementAutoPct,
        volumeBrutT3: quarterSummary.grossTotal,
        reductionNettingPct: quarterSummary.reductionPct,
      },
      sparklineDeclarations,
      barresNettes,
      indicateursDePlace,
      positionsNettesQuarter,
      monthlyDeclarations,
      topWilayas,
      cycleConventionnel,
      alertesConventionnelles,
      commissionOverdue15dCount: commissionSummary.overdue15dCount,
      updatedAt: new Date().toISOString(),
    };
  }
}

@Module({
  imports: [ClaimsModule, MatchingModule, RecoursModule, SettlementModule, CommissionModule, ExpertsModule, AdherentsModule, StatsModule],
  controllers: [CockpitController],
})
export class CockpitModule {}
