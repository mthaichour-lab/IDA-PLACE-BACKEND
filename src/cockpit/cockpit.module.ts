import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';

/**
 * CockpitModule — écran 1 "Cockpit de place". Module AGRÉGATEUR additionnel
 * (en plus des 17 modules de B.2), explicitement demandé pour fournir un
 * endpoint stable `/cockpit/summary` qui agrège les KPIs des autres
 * modules — aucune entité, aucune règle métier propre.
 *
 * TODO(backend-agent): remplacer les valeurs mock par de vrais appels aux
 * services ClaimsModule / MatchingModule / SettlementModule / RecoursModule
 * une fois leur logique réelle implémentée, en conservant EXACTEMENT la
 * forme de `GET /cockpit/summary` ci-dessous (le front est déjà branché
 * dessus — Module I, écran 1).
 */
@ApiTags('cockpit')
@ApiBearerAuth()
@Controller('cockpit')
@UseGuards(AuthGuard)
class CockpitController {
  @Get('summary')
  @ApiOperation({ summary: 'KPIs agrégés du cockpit de place (dossiers du jour, à apparier, en retard, compensation à venir)' })
  summary() {
    return {
      kpis: {
        dossiersDuJour: 37,
        aApparier: 14,
        enRetard: 5,
        compensationAVenir: 2_840_000,
      },
      sparklineDeclarations: [12, 18, 15, 22, 19, 27, 24, 31, 28, 34, 30, 37],
      barresNettes: [
        { company: 'CAAT', net: 120000 },
        { company: 'SAA', net: -45000 },
        { company: 'CASH', net: 68000 },
        { company: 'ALLI', net: -23000 },
      ],
      updatedAt: new Date().toISOString(),
    };
  }
}

@Module({ controllers: [CockpitController] })
export class CockpitModule {}
