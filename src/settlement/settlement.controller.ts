import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { CloseMonthlyDto } from './dto/settlement.dto';
import { SettlementService } from './settlement.service';

/**
 * SettlementModule — écrans 5 "Cycle mensuel" et 6 "Compensation
 * trimestrielle", B.2/B.3. Voir `settlement.rules.ts` (parsing de période,
 * netting bilatéral/multilatéral) et `settlement.service.ts`.
 */
@ApiTags('settlement')
@ApiBearerAuth()
@Controller('settlement')
@UseGuards(AuthGuard, PrivilegesGuard)
export class SettlementController {
  constructor(private readonly service: SettlementService) {}

  @Get('monthly/:period')
  @ApiOperation({ summary: 'Synthèse mensuelle par compagnie (ex: period=2026-01) — état d’avancement réel, à partir des recours (B.7 : scopée par compagnie)' })
  monthly(@Param('period') period: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.monthly(period, user);
  }

  @Post('monthly/:period/close')
  @Privileges('synth')
  @ApiOperation({ summary: 'Clôture de la synthèse mensuelle d’une compagnie et génération du bordereau (idempotent : 409 si déjà clôturée)' })
  closeMonthly(@Param('period') period: string, @Body() dto: CloseMonthlyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.closeMonthly(period, dto.company, user.name);
  }

  @Get('quarter/:q')
  @ApiOperation({ summary: 'Compensation trimestrielle — positions bilatérales nettées et compensation multilatérale (ex: q=2026-Q1) (B.7 : scopée par compagnie)' })
  quarter(@Param('q') q: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.quarter(q, user);
  }

  @Post('quarter/:q/close')
  @Privileges('synth')
  @ApiOperation({ summary: 'Clôture de la compensation trimestrielle et génération du bordereau (idempotent : 409 si déjà clôturée)' })
  closeQuarter(@Param('q') q: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.closeQuarterly(q, user.name);
  }
}
