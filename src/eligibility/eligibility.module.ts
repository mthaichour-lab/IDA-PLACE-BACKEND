import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';

/**
 * EligibilityModule — B.2/B.6 : règles d'éligibilité IDA (Art. 3/4/5-6/13/19/28).
 *
 * TODO(backend-agent): implémenter la logique métier réelle, voir §B.6 du
 * dossier technique :
 *  - deux véhicules exactement (Art. 4), dommages matériels seulement
 *    (Art. 3), territoire algérien (Art. 3), partie adverse adhérente et
 *    active (Art. 3/28), montant ≤ plafond 300 000 DA (provisoire
 *    v2025.12, Art. 4), recours ≤ 6 mois / non forclos (Art. 19), aucune
 *    exclusion (Art. 5-6), pièces obligatoires présentes (Art. 13) ;
 *  - exposer un service injectable `EligibilityService.evaluate(row)` que
 *    `ClaimsModule` appellera depuis `buildMockImportReport` (actuellement
 *    un mock, voir claims.service.ts) ;
 *  - rendre le plafond et les délais paramétrables (grille de versions,
 *    ex "v2025.12") plutôt qu'en dur.
 * Le endpoint ci-dessous ne fait que lister les règles pour affichage
 * (le front n'évalue jamais l'éligibilité — règle d'or C.4).
 */
@ApiTags('eligibility')
@ApiBearerAuth()
@Controller('eligibility')
@UseGuards(AuthGuard)
class EligibilityController {
  @Get('rules')
  @ApiOperation({ summary: "Référentiel des règles d'éligibilité IDA (lecture, B.6)" })
  rules() {
    return [
      { article: 'Art. 3', rule: 'Dommages matériels uniquement, territoire algérien' },
      { article: 'Art. 4', rule: 'Deux véhicules exactement, montant ≤ plafond (300 000 DA, v2025.12)' },
      { article: 'Art. 5-6', rule: 'Aucune exclusion contractuelle' },
      { article: 'Art. 13', rule: 'Pièces obligatoires présentes' },
      { article: 'Art. 19', rule: 'Recours dans les 6 mois, non forclos' },
      { article: 'Art. 28', rule: 'Partie adverse adhérente et active' },
    ];
  }
}

@Module({ controllers: [EligibilityController] })
export class EligibilityModule {}
