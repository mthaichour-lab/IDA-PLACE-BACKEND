import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaginatedResult, paginateArray } from '../common/dto/pagination.dto';
import { ClaimsService } from '../claims/claims.service';
import { CommissionService } from '../commission/commission.service';
import { MatchingService } from '../matching/matching.service';
import { RecoursService } from '../recours/recours.service';
import {
  ClaimMonitoringInput,
  computeCompositeScore,
  computeDelaisScore,
  computeDemandesTardivesScore,
  computeForclusionsScore,
  computeOppositionsScore,
  computePenalitesScore,
  computeQualiteDonneesScore,
  computeSilencesScore,
  MONITORING_WEIGHTS,
  MonitoringCompanyResult,
  MonitoringComponentKey,
  MonitoringComponentValue,
  RecoursMonitoringInput,
} from './monitoring.scoring';
import { DEFAULT_ELIGIBILITY_CONFIG } from '../eligibility/eligibility.rules';

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

  constructor(
    private readonly claims: ClaimsService,
    private readonly matching: MatchingService,
    private readonly recours: RecoursService,
    private readonly commission: CommissionService,
    configService: ConfigService,
  ) {
    this.recoursMaxMonths = Number(
      configService.get<string>('ELIGIBILITY_RECOURS_MAX_MONTHS') ?? DEFAULT_ELIGIBILITY_CONFIG.recoursMaxMonths,
    );
  }

  async scores(): Promise<{ weights: typeof MONITORING_WEIGHTS; companies: MonitoringCompanyResult[]; notes: string[] }> {
    const [{ items: allClaims }, allRecours, { items: allSanctions }] = await Promise.all([
      this.claims.list({ page: 1, pageSize: 100_000 }),
      this.recours.listAll(),
      this.commission.listSanctions({ page: 1, pageSize: 100_000 }),
    ]);

    const recoursInputs: RecoursMonitoringInput[] = allRecours.map((r) => ({
      from: r.from,
      to: r.to,
      state: r.state,
      opposition: r.opposition,
      resolutionKind: r.resolution?.kind,
    }));

    const sanctionCountByCompany = new Map<string, number>();
    for (const s of allSanctions) {
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

      return { code, score: computeCompositeScore(details), rank: 0, details };
    });

    results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    results.forEach((r, i) => (r.rank = i + 1));

    return {
      weights: MONITORING_WEIGHTS,
      companies: results,
      notes: [
        'silences : taux de recours reçus résolus par silence (Art.10) parmi ceux déjà résolus — hypothèse documentée, voir monitoring.scoring.ts.',
        'oppositions : taux d’oppositions reçues (sur les recours émis par la compagnie) non suivies d’effet (Art.12, faute de transmission en commission) — hypothèse documentée, mesure l’engagement, pas la légitimité du recours initial.',
        'penalites : -20 points par sanction (tous types confondus), barème non chiffré par le dossier technique — hypothèse à valider avec l’UAR.',
        'délais : latence réelle (accident → ingestion du dossier), PAS la définition complète du dossier technique (règlement/recours non réels) — voir monitoring.scoring.ts.',
        'demandesTardives : hypothèse documentée (plus de 50% du délai de recours autorisé écoulé, sans être forclos) — à valider avec le métier.',
      ],
    };
  }

  /** Parcours inter-compagnies par dossier — dérivé de la file réelle de MatchingModule (B.5). */
  async trajectories(page: number, pageSize: number): Promise<PaginatedResult<TrajectoryDto>> {
    const queue = await this.matching.queue({ filter: 'TOUS', page: 1, pageSize: 100_000 });
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
    return paginateArray(rows, page, pageSize);
  }
}
