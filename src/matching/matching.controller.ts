import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Authenticated } from '../common/decorators/access.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { MatchDecisionDto, MatchQueueQueryDto } from './dto/matching.dto';
import { MatchingService } from './matching.service';

/** MatchingModule — écran 2 "Confrontation & matching" (B.7 : scoping tenant réel, voir matching.service.ts). */
@ApiTags('matching')
@ApiBearerAuth()
@Controller('matching')
export class MatchingController {
  constructor(private readonly service: MatchingService) {}

  @Get('queue')
  // SEC-43 : lecture scopée par compagnie dans le service (paires dont la compagnie est partie)
  @Authenticated()
  @ApiOperation({ summary: 'File de confrontation A/B, paginée (6/p), filtrable (Tous/Auto/À confirmer/Non appariés) (B.7 : scopée par compagnie)' })
  queue(@Query() q: MatchQueueQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.queue(q, user);
  }

  @Get('queue/counters')
  // SEC-43 : lecture scopée par compagnie dans le service
  @Authenticated()
  @ApiOperation({ summary: 'Compteurs par onglet (Tous/Auto/À confirmer/Non appariés) (B.7 : scopés par compagnie)' })
  counters(@CurrentUser() user: AuthenticatedUser) {
    return this.service.counters(user);
  }

  @Get('thresholds')
  // SEC-43 : seuils d'appariement de la place (paramètres communs, non confidentiels)
  @Authenticated()
  @ApiOperation({ summary: "Seuils d'appariement auto / à confirmer (paramétrables)" })
  thresholds() {
    return this.service.getThresholds();
  }

  @Get(':id')
  // SEC-43 : lecture scopée par compagnie dans le service (partie à la paire)
  @Authenticated()
  @ApiOperation({ summary: 'Détail d’un appariement : saisies Art. 14 de A et B, divergence de code, taux selon barème si une version VALIDE_UAR couvre le code (B.7 : scopé par compagnie)' })
  get(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getItem(id, user);
  }

  @Get(':id/decisions')
  // SEC-43 : lecture scopée par compagnie dans le service (partie à la paire)
  @Authenticated()
  @ApiOperation({ summary: 'SEC-28 — historique des décisions d’une ligne de confrontation (auteur, état avant/après, motif) ; auteurs d’autres compagnies masqués (B.7 : scopé par compagnie)' })
  decisions(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.decisionHistory(id, user);
  }

  @Post(':id/decide')
  @Privileges('matchDecide')
  @ApiOperation({ summary: 'Décision de confrontation : confirm | reject | complement | link (Art. 14, validation humaine) — SEC-28 : historisée ; revenir sur une décision exige un motif (400 MOTIF_REQUIS) ; link exige un linkDeclId valide' })
  decide(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: MatchDecisionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.decide(id, dto, user.name, user);
  }
}
