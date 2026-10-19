import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Authenticated } from '../common/decorators/access.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { ListRecoursQueryDto, RecoursHistoryEntryDto, RecoursTransitionDto } from './dto/recours.dto';
import { RecoursService } from './recours.service';

/**
 * RecoursModule — écran 4 "Échanges Annexes 2/3/4", B.2/B.3. Voir
 * `recours.rules.ts` (timers Art.10/12/19, machine d'état) et
 * `recours.service.ts` pour le détail de l'implémentation.
 * SEC-44 : identifiants validés (`ParseUUIDPipe`), requêtes typées.
 * SEC-46 : hors périmètre, 404 identique à un recours inexistant.
 */
@ApiTags('recours')
@ApiBearerAuth()
@Controller('recours')
export class RecoursController {
  constructor(private readonly service: RecoursService) {}

  @Get()
  // SEC-43 : lecture scopée par compagnie dans le service (créancière ou débitrice)
  @Authenticated()
  @ApiOperation({ summary: 'Registre des recours (Annexes 2/3/4), paginé (6/p, 100 max), filtrable par état — countdownBar calculée serveur (Art.10/12/19) (B.7 : scopé par compagnie)' })
  list(@Query() q: ListRecoursQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.list(q, user);
  }

  @Get('counters')
  // SEC-43 : lecture scopée par compagnie dans le service (créancière ou débitrice)
  @Authenticated()
  @ApiOperation({ summary: 'Compteurs par onglet (tous / en attente / opposition / contestation / commission / forclos / réglé / rejeté) (B.7 : scopés par compagnie)' })
  counters(@CurrentUser() user: AuthenticatedUser) {
    return this.service.counters(user);
  }

  @Get(':id')
  // SEC-43 : lecture scopée par compagnie dans le service (créancière ou débitrice)
  @Authenticated()
  @ApiOperation({ summary: "Fiche détail d'un recours (B.7 : scopé par compagnie ; 404 hors périmètre)" })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getForUser(id, user);
  }

  @Get(':id/history')
  // SEC-43 : lecture scopée par compagnie dans le service (créancière ou débitrice)
  @Authenticated()
  @ApiOperation({ summary: 'Historique des transitions (auteur, rôle, compagnie représentée, motif) — audit, réservé aux rôles place (404 sinon)' })
  history(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser): Promise<RecoursHistoryEntryDto[]> {
    return this.service.history(id, user);
  }

  @Post(':id/transition')
  @Privileges('exchange', 'decide')
  @ApiOperation({
    summary:
      "Transition d'état d'un recours : accepter | opposer | lever_opposition | contester | transmettre_commission | cloturer_commission_favorable | cloturer_commission_defavorable (409 si modifié entre-temps ; clôture en commission : décision prononcée au PV signé)",
  })
  transition(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecoursTransitionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.transition(id, dto, user);
  }
}
