import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdherentsModule } from '../adherents/adherents.module';
import { Authenticated } from '../common/decorators/access.decorator';
import { ClaimsModule } from '../claims/claims.module';
import { RecoursModule } from '../recours/recours.module';
import { StatsService } from './stats.service';
import { StatsWilayasQueryDto } from './dto/stats-query.dto';

/**
 * StatsModule — écran 11 "Statistiques de la place", B.2. Agrégation RÉELLE
 * depuis `ClaimsModule` + `RecoursModule` ; populations et référence IRSAM
 * lues dans le référentiel de place (`AdherentsService`). Voir
 * `stats.service.ts` pour les métriques encore omises plutôt qu'inventées.
 */
@ApiTags('stats')
@ApiBearerAuth()
@Controller('stats')
class StatsController {
  constructor(private readonly service: StatsService) {}

  @Get('wilayas')
  // SEC-43 : agrégats de place (écran 11), sans donnée par compagnie
  @Authenticated()
  @ApiOperation({
    summary:
      'Carte en tuiles des 69 wilayas (grille 13×8) — déclarations/montants réels, `per100k` seulement si une population valide est saisie (sinon null) ; `year` optionnel = année étudiée',
  })
  wilayas(@Query() q: StatsWilayasQueryDto) {
    return this.service.wilayas(q.year);
  }

  @Get('monthly')
  // SEC-43 : agrégats de place (écran 11), sans donnée par compagnie
  @Authenticated()
  @ApiOperation({ summary: "Activité mensuelle réelle : déclarations (par mois d'accident), canal (e-constat vs autres canaux), Annexes 2 émises / oppositions / recours réglés (RecoursModule, réel)" })
  monthly() {
    return this.service.monthly();
  }

  @Get('summary')
  // SEC-43 : agrégats de place (écran 11), sans donnée par compagnie
  @Authenticated()
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
