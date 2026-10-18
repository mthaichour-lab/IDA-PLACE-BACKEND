import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { CreateRecoursDto, ListRecoursQueryDto, RecoursTransitionDto } from './dto/recours.dto';
import { RecoursService } from './recours.service';

/**
 * RecoursModule — écran 4 "Échanges Annexes 2/3/4", B.2/B.3. Voir
 * `recours.rules.ts` (timers Art.10/12/19, machine d'état) et
 * `recours.service.ts` pour le détail de l'implémentation.
 */
@ApiTags('recours')
@ApiBearerAuth()
@Controller('recours')
@UseGuards(AuthGuard, PrivilegesGuard)
export class RecoursController {
  constructor(private readonly service: RecoursService) {}

  @Get()
  @ApiOperation({ summary: 'Registre des recours (Annexes 2/3/4), paginé (6/p), filtrable par état — countdownBar calculée serveur (Art.10/12/19) (B.7 : scopé par compagnie)' })
  list(@Query() q: ListRecoursQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.list(q, user);
  }

  @Get('counters')
  @ApiOperation({ summary: 'Compteurs par onglet (tous / en attente / opposition / contestation / commission / forclos / réglé / rejeté) (B.7 : scopés par compagnie)' })
  counters(@CurrentUser() user: AuthenticatedUser) {
    return this.service.counters(user);
  }

  @Get(':id')
  @ApiOperation({ summary: "Fiche détail d'un recours (B.7 : scopé par compagnie)" })
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.get(id, user);
  }

  @Post()
  @Privileges('insert')
  @ApiOperation({ summary: "Enregistrement d'un nouveau recours (Annexe 2) pour un dossier éligible IDA (B.7 : `from` doit être la compagnie de l'appelant, sauf rôle place)" })
  create(@Body() dto: CreateRecoursDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.create(dto, user);
  }

  @Post(':id/transition')
  @Privileges('exchange', 'decide')
  @ApiOperation({
    summary:
      "Transition d'état d'un recours : accepter | opposer | lever_opposition | contester | transmettre_commission | cloturer_commission_favorable | cloturer_commission_defavorable",
  })
  transition(@Param('id') id: string, @Body() dto: RecoursTransitionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.transition(id, dto, user);
  }
}
