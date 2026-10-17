import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { CommissionService } from './commission.service';
import { CreatePenaltyDto, CreatePvDto, CreateSanctionDto, ListCommissionCasesQueryDto } from './dto/commission.dto';

/**
 * CommissionModule — écran 7 "Commission", B.2/B.3. Voir TODO/hypothèses
 * documentées dans `commission.service.ts`.
 */
@ApiTags('commission')
@ApiBearerAuth()
@Controller('commission')
@UseGuards(AuthGuard, PrivilegesGuard)
export class CommissionController {
  constructor(private readonly service: CommissionService) {}

  @Get('cases')
  @ApiOperation({ summary: 'File de conciliation — recours escaladés en commission (RecoursModule, Art. 12), paginée (6/p)' })
  cases(@Query() q: ListCommissionCasesQueryDto) {
    return this.service.cases(q);
  }

  @Get('sanctions')
  @ApiOperation({ summary: 'Historique des pénalités/sanctions prononcées, paginé (6/p)' })
  sanctions(@Query() q: ListCommissionCasesQueryDto) {
    return this.service.listSanctions(q);
  }

  @Post(':id/penalty')
  @Privileges('penaltyOrder')
  @ApiOperation({ summary: 'Prononcé de pénalité contre une compagnie, au titre d’un recours escaladé' })
  penalty(@Param('id') id: string, @Body() dto: CreatePenaltyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.penalty(id, dto, user.name);
  }

  @Post(':id/sanction')
  @Privileges('sanction')
  @ApiOperation({ summary: 'Prononcé de sanction contre une compagnie, au titre d’un recours escaladé' })
  sanction(@Param('id') id: string, @Body() dto: CreateSanctionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.sanction(id, dto, user.name);
  }

  @Post(':id/pv-sign')
  @Privileges('pvSign')
  @ApiOperation({ summary: 'Rédaction + signature du PV de commission (motif/décision/signataires)' })
  pvSign(@Param('id') id: string, @Body() dto: CreatePvDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.pvSign(id, dto, user.name);
  }
}
