import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
import { ClaimsModule } from '../claims/claims.module';
import { StatsService } from './stats.service';

/**
 * StatsModule — écran 11 "Statistiques de la place", B.2. Agrégation RÉELLE
 * depuis `ClaimsModule` (voir `stats.service.ts` pour le détail des
 * métriques omises plutôt qu'inventées : population par wilaya, Annexes 2/
 * oppositions/indemnisés, mobile vs agence).
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
  @ApiOperation({ summary: "Activité mensuelle réelle (déclarations, par mois d'accident) + canal (e-constat vs autres) — Annexes 2/oppositions/indemnisés omis (RecoursModule/SettlementModule non réels, voir stats.service.ts)" })
  monthly() {
    return this.service.monthly();
  }
}

@Module({
  imports: [ClaimsModule],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
