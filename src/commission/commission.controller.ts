import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import {
  CreateCommissionCaseDto,
  DecideCommissionDto,
  ListCommissionCasesQueryDto,
  ListSanctionsQueryDto,
  PenaltyDto,
  PvSignDto,
  SanctionOrderDto,
} from './dto/commission.dto';
import { CommissionService } from './commission.service';

/**
 * CommissionModule — écran 7 "Commission", B.2. Voir `commission.rules.ts`
 * (machine d'état séquentielle) et `commission.service.ts`.
 */
@ApiTags('commission')
@ApiBearerAuth()
@Controller('commission')
@UseGuards(AuthGuard, PrivilegesGuard)
export class CommissionController {
  constructor(private readonly service: CommissionService) {}

  @Get('cases')
  @ApiOperation({ summary: 'File de conciliation, paginée (6/p), filtrable par statut' })
  listCases(@Query() q: ListCommissionCasesQueryDto) {
    return this.service.listCases(q);
  }

  @Get('cases/:id')
  @ApiOperation({ summary: "Fiche détail d'un dossier de commission" })
  getCase(@Param('id') id: string) {
    return this.service.getCase(id);
  }

  @Post('cases')
  @Privileges('exchange')
  @ApiOperation({ summary: 'Ouverture d’un dossier de conciliation à partir d’un recours transmis en commission' })
  createCase(@Body() dto: CreateCommissionCaseDto) {
    return this.service.createCase(dto);
  }

  @Post('cases/:id/deliberate')
  @Privileges('decide')
  @ApiOperation({ summary: 'Passage en délibéré (A_INSTRUIRE -> EN_DELIBERE)' })
  deliberate(@Param('id') id: string) {
    return this.service.deliberate(id);
  }

  @Post('cases/:id/decide')
  @Privileges('decide')
  @ApiOperation({ summary: 'Prononcé de la décision de commission (EN_DELIBERE -> PRONONCE)' })
  decide(@Param('id') id: string, @Body() dto: DecideCommissionDto) {
    return this.service.decide(id, dto);
  }

  @Post('cases/:id/penalty')
  @Privileges('penaltyOrder')
  @ApiOperation({ summary: 'Prononcé de pénalité financière à l’encontre d’une des deux compagnies parties au recours' })
  penalty(@Param('id') id: string, @Body() dto: PenaltyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.penalty(id, dto, user.name);
  }

  @Post('cases/:id/sanction')
  @Privileges('sanction')
  @ApiOperation({ summary: 'Prononcé de sanction (avertissement/suspension) à l’encontre d’une des deux compagnies parties au recours' })
  sanction(@Param('id') id: string, @Body() dto: SanctionOrderDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.sanction(id, dto, user.name);
  }

  @Post('cases/:id/pv-sign')
  @Privileges('pvSign')
  @ApiOperation({ summary: 'Signature du PV de commission (uniquement après le prononcé de la décision)' })
  pvSign(@Param('id') id: string, @Body() dto: PvSignDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.pvSign(id, dto, user.name);
  }

  @Get('sanctions')
  @ApiOperation({ summary: 'Registre des pénalités/sanctions, paginé (6/p), filtrable par compagnie' })
  listSanctions(@Query() q: ListSanctionsQueryDto) {
    return this.service.listSanctions(q);
  }
}
