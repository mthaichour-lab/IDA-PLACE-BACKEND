import { Controller, Get, Module, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
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
 *
 * Revue sécurité 2026-10-18 (B.7) : `scores()` reste VOLONTAIREMENT
 * place-wide (pas de scoping tenant) — le dossier technique décrit
 * explicitement l'écran 8 comme incluant un "classement" inter-compagnies
 * (§Détail par écran, item 8), une transparence mutuelle documentée comme
 * une fonctionnalité du screen, pas un oubli. En revanche `trajectories()`
 * et `journeys(:code)` dérivent des données déjà protégées ailleurs
 * (`MatchingModule.queue()`/`RecoursModule`) et ne doivent pas contourner
 * cette protection — `user` désormais transmis aux deux.
 */
@ApiTags('monitoring')
@ApiBearerAuth()
@Controller('monitoring')
@UseGuards(AuthGuard, PrivilegesGuard)
class MonitoringController {
  constructor(private readonly service: MonitoringService) {}

  @Get('scores')
  @ApiOperation({ summary: 'Scoring composite de conformité par compagnie — toutes composantes réelles (délais, silences, oppositions, qualité données, forclusions, demandes tardives, pénalités), hypothèses documentées (voir notes). Volontairement place-wide (classement documenté, voir doc de classe).' })
  scores() {
    return this.service.scores();
  }

  @Get('trajectories')
  @ApiOperation({ summary: 'Parcours inter-compagnies par dossier (réel, dérivé de la file de confrontation MatchingModule — B.7 : ne montre que les paires où la compagnie de l’appelant est partie)' })
  trajectories(@Query() q: PaginationQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.trajectories(q.page, q.pageSize, user);
  }

  @Get('companies/:code/journeys')
  @ApiOperation({ summary: 'Vue par dossier — parcours complet pour une compagnie (étapes réelles du recours, voir recours.rules.ts) — B.7 : scopée par compagnie' })
  journeys(@Param('code') code: string, @Query() q: PaginationQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.journeys(code, q.page, q.pageSize, user);
  }
}

@Module({
  imports: [ClaimsModule, MatchingModule, RecoursModule, CommissionModule],
  controllers: [MonitoringController],
  providers: [MonitoringService],
})
export class MonitoringModule {}
