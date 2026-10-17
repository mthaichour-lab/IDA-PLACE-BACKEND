import { Controller, Get, Module, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { ClaimsModule } from '../claims/claims.module';
import { CommissionModule } from '../commission/commission.module';
import { MatchingModule } from '../matching/matching.module';
import { RecoursModule } from '../recours/recours.module';
import { MonitoringService } from './monitoring.service';

/**
 * MonitoringModule — écran 8 "Monitoring assureurs", B.2.
 *
 * Scoring composite entièrement branché sur des données réelles (délais,
 * qualité données, forclusions, demandes tardives : `ClaimsModule`/
 * `EligibilityModule` ; silences/oppositions : `RecoursModule` ; pénalités :
 * `CommissionModule`) — toutes composantes `dataSource: 'REEL'` dès qu'une
 * compagnie a au moins un dossier/recours ; hypothèses de calcul
 * documentées dans `monitoring.scoring.ts`, à valider avec le métier/l'UAR.
 */
@ApiTags('monitoring')
@ApiBearerAuth()
@Controller('monitoring')
@UseGuards(AuthGuard)
class MonitoringController {
  constructor(private readonly service: MonitoringService) {}

  @Get('scores')
  @ApiOperation({ summary: 'Scoring composite de conformité par compagnie — toutes composantes réelles (délais, silences, oppositions, qualité données, forclusions, demandes tardives, pénalités), hypothèses documentées (voir notes)' })
  scores() {
    return this.service.scores();
  }

  @Get('trajectories')
  @ApiOperation({ summary: 'Parcours inter-compagnies par dossier (réel, dérivé de la file de confrontation MatchingModule)' })
  trajectories(@Query() q: PaginationQueryDto) {
    return this.service.trajectories(q.page, q.pageSize);
  }
}

@Module({
  imports: [ClaimsModule, MatchingModule, RecoursModule, CommissionModule],
  controllers: [MonitoringController],
  providers: [MonitoringService],
})
export class MonitoringModule {}
