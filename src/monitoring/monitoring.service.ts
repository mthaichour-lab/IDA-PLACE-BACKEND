import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaginatedResult, paginateArray } from '../common/dto/pagination.dto';
import { ClaimsService } from '../claims/claims.service';
import { MatchingService } from '../matching/matching.service';
import {
  ClaimMonitoringInput,
  computeCompositeScore,
  computeDelaisScore,
  computeDemandesTardivesScore,
  computeForclusionsScore,
  computeQualiteDonneesScore,
  MONITORING_WEIGHTS,
  MonitoringCompanyResult,
  MonitoringComponentKey,
  MonitoringComponentValue,
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
    configService: ConfigService,
  ) {
    this.recoursMaxMonths = Number(
      configService.get<string>('ELIGIBILITY_RECOURS_MAX_MONTHS') ?? DEFAULT_ELIGIBILITY_CONFIG.recoursMaxMonths,
    );
  }

  async scores(): Promise<{ weights: typeof MONITORING_WEIGHTS; companies: MonitoringCompanyResult[]; notes: string[] }> {
    const { items: allClaims } = await this.claims.list({ page: 1, pageSize: 100_000 });

    const companyCodes = new Set<string>();
    for (const c of allClaims) {
      if (c.company) companyCodes.add(c.company);
      if (c.counterpartyCompany) companyCodes.add(c.counterpartyCompany);
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

      const placeholder = (): MonitoringComponentValue => ({ value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 });

      const details: Record<MonitoringComponentKey, MonitoringComponentValue> = {
        delais: computeDelaisScore(companyClaims),
        qualiteDonnees: computeQualiteDonneesScore(companyClaims),
        forclusions: computeForclusionsScore(companyClaims),
        demandesTardives: computeDemandesTardivesScore(companyClaims, this.recoursMaxMonths),
        // Placeholders explicites — jamais une valeur inventée (voir
        // monitoring.scoring.ts et HANDOFF du sprint pour le TODO).
        silences: placeholder(),
        oppositions: placeholder(),
        penalites: placeholder(),
      };

      return { code, score: computeCompositeScore(details), rank: 0, details };
    });

    results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    results.forEach((r, i) => (r.rank = i + 1));

    return {
      weights: MONITORING_WEIGHTS,
      companies: results,
      notes: [
        'silences, oppositions et pénalités : NON DISPONIBLES ce sprint (dépendent de RecoursModule/CommissionModule, hors périmètre — valeurs volontairement null, jamais inventées).',
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
