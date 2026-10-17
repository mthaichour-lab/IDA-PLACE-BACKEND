import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { ContesterRecoursDto, CreateRecoursDto, ListRecoursQueryDto, OpposerRecoursDto, SettleRecoursDto } from './dto/recours.dto';
import { RecoursService } from './recours.service';

/**
 * RecoursModule — écran 4 "Échanges Annexes 2/3/4", B.2/B.3. Machine à
 * états + timers conventionnels réels (Art. 10/12/19) — voir TODO/hypothèses
 * documentées dans `recours.rules.ts` et `recours.service.ts`.
 */
@ApiTags('recours')
@ApiBearerAuth()
@Controller('recours')
@UseGuards(AuthGuard, PrivilegesGuard)
export class RecoursController {
  constructor(private readonly service: RecoursService) {}

  @Get()
  @ApiOperation({ summary: 'Registre des recours (Annexes 2/3/4), paginé (6/p), filtrable par état (B.7 : scopé par compagnie)' })
  list(@Query() q: ListRecoursQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.list(q, user);
  }

  @Get('timer-config')
  @ApiOperation({ summary: 'Délais conventionnels appliqués (Art. 10/12/19) — paramétrables par variable d’environnement' })
  timerConfig() {
    return this.service.getTimerConfig();
  }

  @Get(':id')
  @ApiOperation({ summary: "Détail d'un recours" })
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.get(id, user);
  }

  @Post()
  @Privileges('insert')
  @ApiOperation({ summary: 'Envoi d’un nouveau recours (Annexe 2) — démarre le délai de silence (Art. 10)' })
  create(@Body() dto: CreateRecoursDto) {
    return this.service.create(dto);
  }

  @Post(':id/opposer')
  @Privileges('exchange')
  @ApiOperation({ summary: 'Opposition formulée par la compagnie destinataire, avant échéance (Art. 10)' })
  opposer(@Param('id') id: string, @Body() dto: OpposerRecoursDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.opposer(id, dto, user);
  }

  @Post(':id/contester')
  @Privileges('exchange')
  @ApiOperation({ summary: 'Contestation de l’opposition par la compagnie à l’origine du recours (Art. 12)' })
  contester(@Param('id') id: string, @Body() dto: ContesterRecoursDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.contester(id, dto, user);
  }

  @Post(':id/settle')
  @Privileges('pay')
  @ApiOperation({ summary: 'Règlement du recours (accepté tacitement ou tranché en commission)' })
  settle(@Param('id') id: string, @Body() dto: SettleRecoursDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.settle(id, dto, user);
  }
}
