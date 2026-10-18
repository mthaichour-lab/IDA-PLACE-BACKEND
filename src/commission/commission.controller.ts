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
  @ApiOperation({ summary: 'File de conciliation, paginée (6/p), filtrable par statut (B.7 : scopée par compagnie)' })
  listCases(@Query() q: ListCommissionCasesQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listCases(q, user);
  }

  @Get('cases/:id')
  @ApiOperation({ summary: "Fiche détail d'un dossier de commission (B.7 : scopée par compagnie)" })
  getCase(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getCase(id, user);
  }

  @Post('cases')
  @Privileges('exchange')
  @ApiOperation({ summary: "Ouverture d'un dossier de conciliation à partir d'un recours transmis en commission (B.7 : le recours cité doit appartenir à la compagnie de l'appelant)" })
  createCase(@Body() dto: CreateCommissionCaseDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.createCase(dto, user);
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
  @ApiOperation({ summary: 'Registre des pénalités/sanctions, paginé (6/p), filtrable par compagnie (B.7 : scopé par compagnie)' })
  listSanctions(@Query() q: ListSanctionsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listSanctions(q, user);
  }

  @Get('summary')
  @ApiOperation({ summary: 'KPI de synthèse : dossiers pendants, hors délai 15j (Art.24), recours jugés fondés, oppositions fondées Art.12 (B.7 : scopé par compagnie)' })
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.service.summary(user);
  }
}
