import { Controller, Get, Module, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { ClaimsModule } from '../claims/claims.module';
import { MatchingModule } from '../matching/matching.module';
import { MonitoringService } from './monitoring.service';

/**
 * MonitoringModule — écran 8 "Monitoring assureurs", B.2.
 *
 * Scoring composite calculé réellement pour les composantes disponibles ce
 * sprint (délais, qualité données, forclusions, demandes tardives — voir
 * `monitoring.scoring.ts`) ; silences/oppositions/pénalités restent des
 * placeholders explicites (`null`), car ils dépendent de RecoursModule/
 * CommissionModule (hors périmètre de ce sprint — voir rapport final).
 * // TODO sprint suivant : brancher silences/oppositions sur RecoursModule,
 * // pénalités sur CommissionModule, une fois ces modules réels.
 */
@ApiTags('monitoring')
@ApiBearerAuth()
@Controller('monitoring')
@UseGuards(AuthGuard)
class MonitoringController {
  constructor(private readonly service: MonitoringService) {}

  @Get('scores')
  @ApiOperation({ summary: 'Scoring composite de conformité par compagnie — réel pour les composantes disponibles (délais, qualité données, forclusions, demandes tardives) ; silences/oppositions/pénalités = null (hors périmètre, voir notes)' })
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
  imports: [ClaimsModule, MatchingModule],
  controllers: [MonitoringController],
  providers: [MonitoringService],
})
export class MonitoringModule {}
