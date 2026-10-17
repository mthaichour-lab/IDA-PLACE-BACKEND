import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
import { ClaimsModule } from '../claims/claims.module';
import { RecoursModule } from '../recours/recours.module';
import { StatsService } from './stats.service';

/**
 * StatsModule — écran 11 "Statistiques de la place", B.2. Agrégation RÉELLE
 * depuis `ClaimsModule` + `RecoursModule` (voir `stats.service.ts` pour le
 * détail des métriques encore omises plutôt qu'inventées : population par
 * wilaya, e-constat mobile vs agence, comparatif IRSAM, codes de barème).
 */
@ApiTags('stats')
@ApiBearerAuth()
@Controller('stats')
@UseGuards(AuthGuard)
class StatsController {
  constructor(private readonly service: StatsService) {}

  @Get('wilayas')
  @ApiOperation({ summary: 'Carte en tuiles des 69 wilayas (grille 13×8) — déclarations/montants réels (voir stats.service.ts : "pour 100k hab." omis, pas de référentiel de population)' })
  wilayas() {
    return this.service.wilayas();
  }

  @Get('monthly')
  @ApiOperation({ summary: "Activité mensuelle réelle : déclarations (par mois d'accident), canal (e-constat vs autres canaux), Annexes 2 émises / oppositions / recours réglés (RecoursModule, réel)" })
  monthly() {
    return this.service.monthly();
  }

  @Get('summary')
  @ApiOperation({ summary: 'KPI de synthèse : déclarations totales, taux d’opposition, montant compensé, délai moyen de règlement (voir stats.service.ts pour les KPI volontairement omis)' })
  summary() {
    return this.service.summary();
  }
}

@Module({
  imports: [ClaimsModule, RecoursModule],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
