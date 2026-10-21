import { Injectable, Optional } from '@nestjs/common';
import { CacheService } from '../common/cache/cache.service';
import { AggregateCache } from '../stats/aggregate-cache';
import { ConfigService } from '@nestjs/config';
import { PaginatedResult, paginateArray } from '../common/dto/pagination.dto';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { assertCompanyAccess, resolveTenantFilter } from '../common/rbac/tenant-scope';
import { ClaimsService } from '../claims/claims.service';
import { CommissionService } from '../commission/commission.service';
import { MatchingService } from '../matching/matching.service';
import { RecoursService } from '../recours/recours.service';
import { buildRecoursJourneySteps, RecoursJourneyStep, RecoursSnapshot } from '../recours/recours.rules';
import {
  ClaimMonitoringInput,
  computeCompositeScore,
  computeDelaisScore,
  computeDemandesTardivesScore,
  computeForclusionsScore,
  computeMonitoringProfile,
  computeOppositionsScore,
  computePenalitesScore,
  computeQualiteDonneesScore,
  computeSilencesScore,
  gradeFromScore,
  MONITORING_WEIGHTS,
  MonitoringCompanyProfile,
  MonitoringCompanyResult,
  MonitoringComponentKey,
  MonitoringComponentValue,
  OPPOSITION_ALERT_THRESHOLD_PCT,
  RecoursMonitoringInput,
} from './monitoring.scoring';
import { DEFAULT_ELIGIBILITY_CONFIG } from '../eligibility/eligibility.rules';

/**
 * Ligne "Vue par dossier — parcours complet" (écran 8, guide illustré),
 * scopée à une compagnie (`GET /monitoring/companies/:code/journeys`) —
 * voir `buildRecoursJourneySteps` (recours.rules.ts) pour le détail des
 * étapes réelles (pas de taxonomie fixe 8/11 inventée).
 */
export interface MonitoringJourneyDto {
  id: string;
  /** Référence métier du recours (REC-AAAA-NNNNN). */
  reference: string;
  claimId: string;
  direction: 'EMIS' | 'RECU';
  counterparty: string;
  amount: number;
  state: string;
  steps: RecoursJourneyStep[];
  requestSentAt: string;
}

/** SEC-26 : ligne de classement d'une AUTRE compagnie vue par un rôle compagnie (ni `details` ni `profile`). */
export type MonitoringCompanyRanking = Pick<MonitoringCompanyResult, 'code' | 'score' | 'grade' | 'rank'>;

export interface MonitoringScoresDto {
  weights: typeof MONITORING_WEIGHTS;
  companies: Array<MonitoringCompanyResult | MonitoringCompanyRanking>;
  notes: string[];
  silenceDays: number;
  oppositionAlertThresholdPct: number;
}

/** SEC-13 : durée de cache du classement (Redis uniquement). */
const MONITORING_CACHE_TTL_SECONDS = 30;

export interface TrajectoryDto {
  claimRef: string;
  companyA: string;
  companyB?: string;
  refB?: string;
  score: number;
  level: string;
  status: string;
  at: string;
  confirmedBy?: string;
  confirmedAt?: string;
}

/**
 * MonitoringModule — écran 8 "Monitoring assureurs", B.2. Voir
 * `monitoring.scoring.ts` pour le détail des composantes réelles vs
 * placeholders documentés (silences/oppositions/pénalités, hors périmètre
 * de ce sprint — RecoursModule/CommissionModule).
 *
 * Classement des compagnies : dérivé des compagnies RÉELLEMENT observées
 * dans `ClaimsModule` (code `company`/`counterpartyCompany`) — pas d'un
 * référentiel figé en dur (ex. l'ancien mock `['CAAT','SAA','CASH','ALLI']`),
 * pour refléter l'activité réelle de la place.
 */
@Injectable()
export class MonitoringService {
  private readonly recoursMaxMonths: number;
  private readonly aggregates: AggregateCache;

  constructor(
    private readonly claims: ClaimsService,
    private readonly matching: MatchingService,
    private readonly recours: RecoursService,
    private readonly commission: CommissionService,
    configService: ConfigService,
    @Optional() cache?: CacheService,
  ) {
    this.aggregates = new AggregateCache(cache);
    this.recoursMaxMonths = Number(
      configService.get<string>('ELIGIBILITY_RECOURS_MAX_MONTHS') ?? DEFAULT_ELIGIBILITY_CONFIG.recoursMaxMonths,
    );
  }

  /**
   * SEC-13 : classement place-entière mis en cache (Redis si activé) + un
   * seul calcul simultané. SEC-26 : le classement reste visible de tous
   * (transparence documentée, écran 8), mais un rôle compagnie ne reçoit le
   * détail (`details`, `profile` brut, effectifs) que pour SA compagnie ;
   * pour les autres : code, rang, note et score seulement.
   */
  async scores(user?: AuthenticatedUser): Promise<MonitoringScoresDto> {
    const all = await this.aggregates.get('monitoring:scores', MONITORING_CACHE_TTL_SECONDS, () => this.computeScores());
    const tenant = user ? resolveTenantFilter(user) : undefined;
    if (!tenant) return all;
    return {
      ...all,
      companies: all.companies.map((c) => (c.code === tenant ? c : { code: c.code, score: c.score, grade: c.grade, rank: c.rank })),
    };
  }

  private async computeScores(): Promise<MonitoringScoresDto> {
    const [{ items: allClaims }, allRecours, { items: allSanctions }] = await Promise.all([
      this.claims.listAllForAnalysis(),
      this.recours.listAll(),
      this.commission.listSanctions({ page: 1, pageSize: 100_000 }),
    ]);

    const recoursInputs: RecoursMonitoringInput[] = allRecours.map((r) => ({
      from: r.from,
      to: r.to,
      state: r.state,
      opposition: r.opposition,
      contestation: r.contestation,
      resolutionKind: r.resolution?.kind,
      requestSentAt: r.requestSentAt,
      responseAt: r.responseAt,
    }));
    const silenceDays = this.recours.getTimerConfig().silenceDays;

    const sanctionCountByCompany = new Map<string, number>();
    // Seules les sanctions PRONONCÉES comptent (une sanction A_CONTRESIGNER n'est pas encore exécutoire, SEC-32).
    for (const s of allSanctions.filter((x) => x.status === 'PRONONCEE')) {
      sanctionCountByCompany.set(s.companyCode, (sanctionCountByCompany.get(s.companyCode) ?? 0) + 1);
    }

    const companyCodes = new Set<string>();
    for (const c of allClaims) {
      if (c.company) companyCodes.add(c.company);
      if (c.counterpartyCompany) companyCodes.add(c.counterpartyCompany);
    }
    for (const r of allRecours) {
      companyCodes.add(r.from);
      companyCodes.add(r.to);
    }

    const results: MonitoringCompanyResult[] = Array.from(companyCodes).map((code) => {
      const companyClaims: ClaimMonitoringInput[] = allClaims
        .filter((c) => c.company === code)
        .map((c) => ({
          company: code,
          accidentDate: c.accidentDate,
          createdAt: c.createdAt,
          eligibilityVerdict: c.eligibilityVerdict,
          eligibilityReasons: c.eligibilityReasons,
          dateDemandeRecours: c.dateDemandeRecours,
        }));

      const details: Record<MonitoringComponentKey, MonitoringComponentValue> = {
        delais: computeDelaisScore(companyClaims),
        qualiteDonnees: computeQualiteDonneesScore(companyClaims),
        forclusions: computeForclusionsScore(companyClaims),
        demandesTardives: computeDemandesTardivesScore(companyClaims, this.recoursMaxMonths),
        silences: computeSilencesScore(recoursInputs, code),
        oppositions: computeOppositionsScore(recoursInputs, code),
        penalites: computePenalitesScore(sanctionCountByCompany, code),
      };

      const score = computeCompositeScore(details);
      return { code, score, grade: gradeFromScore(score), rank: 0, details, profile: computeMonitoringProfile(recoursInputs, code, silenceDays) };
    });

    results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    results.forEach((r, i) => (r.rank = i + 1));

    return {
      weights: MONITORING_WEIGHTS,
      companies: results,
      silenceDays,
      oppositionAlertThresholdPct: OPPOSITION_ALERT_THRESHOLD_PCT,
      notes: [
        'silences : taux de recours reçus résolus par silence (Art.10) parmi ceux déjà résolus — hypothèse documentée, voir monitoring.scoring.ts.',
        'oppositions : taux d’oppositions reçues (sur les recours émis par la compagnie) non suivies d’effet (Art.12, faute de transmission en commission) — hypothèse documentée, mesure l’engagement, pas la légitimité du recours initial.',
        'penalites : -20 points par sanction (tous types confondus), barème non chiffré par le dossier technique — hypothèse à valider avec l’UAR.',
        'délais : latence réelle (accident → ingestion du dossier) — périmètre confirmé par le Product Owner le 2026-10-18 (non étendu aux délais de règlement/recours), voir QUESTIONS_UAR.md §10.',
        'demandesTardives : plus de 50% du délai de recours autorisé écoulé, sans être forclos — seuil confirmé par le Product Owner le 2026-10-18, voir QUESTIONS_UAR.md §10.',
      ],
    };
  }

  /**
   * "Vue par dossier — parcours complet" (écran 8), scopée à une compagnie
   * — voir `MonitoringJourneyDto`. Revue sécurité 2026-10-18 (B.7) :
   * `assertCompanyAccess` ajouté — ces lignes dérivent de `RecoursModule`,
   * déjà protégé par tenant ailleurs ; sans ce contrôle, ce chemin parallèle
   * exposait la même donnée sensible sans la même protection.
   */
  async journeys(code: string, page: number, pageSize: number, user: AuthenticatedUser): Promise<PaginatedResult<MonitoringJourneyDto>> {
    assertCompanyAccess(user, code);
    const allRecours = await this.recours.listAll();
    const rows: MonitoringJourneyDto[] = allRecours
      .filter((r) => r.from === code || r.to === code)
      .map((r) => ({
        id: r.id,
        reference: r.reference,
        claimId: r.claimId,
        direction: (r.from === code ? 'EMIS' : 'RECU') as 'EMIS' | 'RECU',
        counterparty: r.from === code ? r.to : r.from,
        amount: r.amount,
        state: r.state,
        steps: buildRecoursJourneySteps(r as unknown as RecoursSnapshot),
        requestSentAt: r.requestSentAt,
      }))
      .sort((a, b) => b.requestSentAt.localeCompare(a.requestSentAt));
    return paginateArray(rows, page, pageSize);
  }

  /**
   * Parcours inter-compagnies par dossier — dérivé de la file réelle de
   * MatchingModule (B.5). Revue sécurité 2026-10-18 (B.7) : `user` transmis
   * à `MatchingService.queue()`, qui applique déjà son propre filtre
   * tenant (`visibleToUser`) — l'appeler sans `user` (comme avant) le
   * contournait entièrement (`visibleToUser` renvoie `true` quand `user`
   * est absent, voir matching.service.ts).
   */
  async trajectories(page: number, pageSize: number, user: AuthenticatedUser): Promise<PaginatedResult<TrajectoryDto>> {
    // SEC-13 : la page demandée est lue directement (filtre tenant et pagination en base).
    const queue = await this.matching.queue({ filter: 'TOUS', page, pageSize }, user);
    const rows: TrajectoryDto[] = queue.items.map((i) => ({
      claimRef: i.refA,
      companyA: i.companyA,
      companyB: i.companyB,
      refB: i.refB,
      score: i.score,
      level: i.level,
      status: i.status,
      at: i.at,
      confirmedBy: i.confirmedBy,
      confirmedAt: i.confirmedAt,
    }));
    return new PaginatedResult(rows, queue.total, queue.page);
  }
}
