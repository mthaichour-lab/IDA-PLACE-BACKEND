import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { EligibilityService } from './eligibility.service';

/**
 * EligibilityModule — B.2/B.6 : règles d'éligibilité IDA (Art. 3/4/5-6/13/19/28).
 *
 * La logique métier réelle vit dans `eligibility.rules.ts` (fonctions pures,
 * testées dans `eligibility.service.spec.ts`) et `eligibility.service.ts`
 * (résolution de configuration). `EligibilityService` est exporté pour être
 * consommé par `ClaimsModule.evaluate(row)` lors de l'import (B.4) — le
 * front n'évalue jamais l'éligibilité (règle d'or C.4), il n'affiche que le
 * verdict renvoyé par `POST /claims/import`.
 */
@ApiTags('eligibility')
@ApiBearerAuth()
@Controller('eligibility')
@UseGuards(AuthGuard, PrivilegesGuard)
class EligibilityController {
  constructor(private readonly service: EligibilityService) {}

  @Get('rules')
  @ApiOperation({ summary: "Référentiel des règles d'éligibilité IDA (lecture, B.6)" })
  rules() {
    const cfg = this.service.getConfig();
    return [
      { article: 'Art. 3', rule: 'Dommages matériels uniquement, territoire algérien' },
      { article: 'Art. 4', rule: `Deux véhicules exactement, montant ≤ plafond (${cfg.maxAmountDA.toLocaleString('fr-FR')} DA, ${cfg.version})` },
      { article: 'Art. 5-6', rule: 'Aucune exclusion contractuelle' },
      { article: 'Art. 13', rule: `Pièces obligatoires présentes (${cfg.requiredPieces.join(', ')}) + constat signé des deux parties` },
      { article: 'Art. 19', rule: `Recours dans les ${cfg.recoursMaxMonths} mois, non forclos` },
      { article: 'Art. 28', rule: 'Partie adverse adhérente et active' },
    ];
  }
}

@Module({ controllers: [EligibilityController], providers: [EligibilityService], exports: [EligibilityService] })
export class EligibilityModule {}
