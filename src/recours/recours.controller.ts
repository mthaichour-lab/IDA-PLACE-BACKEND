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
  @ApiOperation({ summary: 'Registre des recours (Annexes 2/3/4), paginé (6/p), filtrable par état — countdownBar calculée serveur (Art.10/12/19)' })
  list(@Query() q: ListRecoursQueryDto) {
    return this.service.list(q);
  }

  @Get('counters')
  @ApiOperation({ summary: 'Compteurs par onglet (tous / en attente / opposition / contestation / commission / forclos / réglé / rejeté)' })
  counters() {
    return this.service.counters();
  }

  @Get(':id')
  @ApiOperation({ summary: "Fiche détail d'un recours" })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  @Privileges('insert')
  @ApiOperation({ summary: "Enregistrement d'un nouveau recours (Annexe 2) pour un dossier éligible IDA" })
  create(@Body() dto: CreateRecoursDto) {
    return this.service.create(dto);
  }

  @Post(':id/transition')
  @Privileges('exchange', 'decide')
  @ApiOperation({
    summary:
      "Transition d'état d'un recours : accepter | opposer | lever_opposition | contester | transmettre_commission | cloturer_commission_favorable | cloturer_commission_defavorable",
  })
  transition(@Param('id') id: string, @Body() dto: RecoursTransitionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.transition(id, dto, user.name);
  }
}
