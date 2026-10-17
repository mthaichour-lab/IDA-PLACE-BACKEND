import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { SettlementService } from './settlement.service';

/**
 * SettlementModule — écrans 5 "Cycle mensuel" et 6 "Compensation
 * trimestrielle", B.2/B.3. Voir hypothèses documentées en tête de
 * `settlement.service.ts`.
 */
@ApiTags('settlement')
@ApiBearerAuth()
@Controller('settlement')
@UseGuards(AuthGuard, PrivilegesGuard)
export class SettlementController {
  constructor(private readonly service: SettlementService) {}

  @Get('monthly/:period')
  @ApiOperation({ summary: 'Synthèse mensuelle par compagnie (ex: period=2026-01), calculée à partir des dossiers réels' })
  monthly(@Param('period') period: string) {
    return this.service.monthly(period);
  }

  @Post('monthly/:period/:company/close')
  @Privileges('seal')
  @ApiOperation({ summary: 'Clôture la synthèse mensuelle d’une compagnie (gèle les valeurs)' })
  closeMonthly(@Param('period') period: string, @Param('company') company: string) {
    return this.service.closeMonthly(period, company);
  }

  @Get('quarter/:q')
  @ApiOperation({ summary: 'Compensation trimestrielle — positions bilatérales et nettes (ex: q=2026-Q1)' })
  quarter(@Param('q') q: string) {
    return this.service.quarter(q);
  }

  @Post('quarter/:q/seal')
  @Privileges('seal')
  @ApiOperation({ summary: 'Scelle la compensation trimestrielle (gèle les valeurs)' })
  sealQuarter(@Param('q') q: string) {
    return this.service.sealQuarter(q);
  }
}
