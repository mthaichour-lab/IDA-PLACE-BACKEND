import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assertEligibilityConfig,
  DEFAULT_ELIGIBILITY_CONFIG,
  EligibilityConfig,
  EligibilityInputRow,
  EligibilityVerdict,
  evaluateEligibility,
} from './eligibility.rules';

/**
 * EligibilityModule — B.2/B.6. Service injectable, consommé par
 * `ClaimsModule` pour produire le verdict ligne à ligne lors de l'import
 * (`POST /claims/import`). La logique métier pure vit dans
 * `eligibility.rules.ts` (testable sans Nest) ; ce service n'ajoute que la
 * résolution de configuration (plafond, délais — paramétrables par
 * variables d'environnement plutôt qu'en dur, voir HANDOFF.md §2).
 */
@Injectable()
export class EligibilityService {
  private readonly config: EligibilityConfig;

  constructor(configService: ConfigService) {
    // SEC-27 : valeur illisible = échec au démarrage, jamais un plafond neutralisé.
    this.config = assertEligibilityConfig({
      version: configService.get<string>('ELIGIBILITY_GRID_VERSION') ?? DEFAULT_ELIGIBILITY_CONFIG.version,
      maxAmountDA: Number(
        configService.get<string>('ELIGIBILITY_MAX_AMOUNT_DA') ?? DEFAULT_ELIGIBILITY_CONFIG.maxAmountDA,
      ),
      recoursMaxMonths: Number(
        configService.get<string>('ELIGIBILITY_RECOURS_MAX_MONTHS') ?? DEFAULT_ELIGIBILITY_CONFIG.recoursMaxMonths,
      ),
      requiredPieces: DEFAULT_ELIGIBILITY_CONFIG.requiredPieces,
    });
  }

  getConfig(): EligibilityConfig {
    return this.config;
  }

  evaluate(row: EligibilityInputRow): EligibilityVerdict {
    return evaluateEligibility(row, this.config);
  }
}
