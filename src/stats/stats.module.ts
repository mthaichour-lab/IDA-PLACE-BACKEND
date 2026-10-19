import { Controller, Get, Module, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdherentsModule } from '../adherents/adherents.module';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { ClaimsModule } from '../claims/claims.module';
import { RecoursModule } from '../recours/recours.module';
import { StatsService } from './stats.service';

/**
 * StatsModule — écran 11 "Statistiques de la place", B.2. Agrégation RÉELLE
 * depuis `ClaimsModule` + `RecoursModule` ; populations et référence IRSAM
 * lues dans le référentiel de place (`AdherentsService`). Voir
 * `stats.service.ts` pour les métriques encore omises plutôt qu'inventées.
 */
@ApiTags('stats')
@ApiBearerAuth()
@Controller('stats')
@UseGuards(AuthGuard, PrivilegesGuard)
class StatsController {
  constructor(private readonly service: StatsService) {}

  @Get('wilayas')
  @ApiOperation({
    summary:
      'Carte en tuiles des 69 wilayas (grille 13×8) — déclarations/montants réels, `per100k` seulement si une population valide est saisie (sinon null) ; `year` optionnel = année étudiée',
  })
  wilayas(@Query('year', new ParseIntPipe({ optional: true })) year?: number) {
    return this.service.wilayas(year);
  }

  @Get('monthly')
  @ApiOperation({ summary: "Activité mensuelle réelle : déclarations (par mois d'accident), canal (e-constat vs autres canaux), Annexes 2 émises / oppositions / recours réglés (RecoursModule, réel)" })
  monthly() {
    return this.service.monthly();
  }

  @Get('summary')
  @ApiOperation({ summary: 'KPI de synthèse : déclarations totales, taux d’opposition, montant compensé, délai moyen de règlement, comparatif IRSAM si une référence est validée UAR (sinon null)' })
  summary() {
    return this.service.summary();
  }
}

@Module({
  imports: [ClaimsModule, RecoursModule, AdherentsModule],
  controllers: [StatsController],
  providers: [StatsService],
  // Exporté (2026-10-18) pour réutilisation par CockpitModule (écran 1,
  // tuiles "déclarations du mois"/"top wilayas") — même principe que les
  // exports déjà en place pour MeteringService/AdherentsService.
  exports: [StatsService],
})
export class StatsModule {}
