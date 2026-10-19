import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Authenticated } from '../common/decorators/access.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import {
  CreateCommissionCaseDto,
  DecideCommissionDto,
  ListCommissionCasesQueryDto,
  ListSanctionsQueryDto,
  PenaltyDto,
  SanctionOrderDto,
} from './dto/commission.dto';
import { CommissionService } from './commission.service';

/**
 * CommissionModule — écran 7 "Commission", B.2. Voir `commission.rules.ts`
 * (machine d'état séquentielle) et `commission.service.ts`.
 * SEC-25 : les actes de commission sont réservés aux rôles place côté service
 * (même avec un privilège obtenu par dérogation). SEC-44 : `ParseUUIDPipe`.
 */
@ApiTags('commission')
@ApiBearerAuth()
@Controller('commission')
export class CommissionController {
  constructor(private readonly service: CommissionService) {}

  @Get('cases')
  // SEC-43 : lecture scopée par compagnie partie au dossier dans le service
  @Authenticated()
  @ApiOperation({ summary: 'File de conciliation, paginée (6/p), filtrable par statut (B.7 : scopée par compagnie)' })
  listCases(@Query() q: ListCommissionCasesQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listCases(q, user);
  }

  @Get('cases/:id')
  // SEC-43 : lecture scopée par compagnie partie au dossier dans le service
  @Authenticated()
  @ApiOperation({ summary: "Fiche détail d'un dossier de commission (B.7 : scopée par compagnie)" })
  getCase(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getCaseForUser(id, user);
  }

  @Post('cases')
  @Privileges('exchange')
  @ApiOperation({ summary: "Ouverture d'un dossier de conciliation à partir d'un recours transmis en commission — un seul par recours (409), recours à l'état COMMISSION (409), 404 si le recours est hors périmètre de l'appelant" })
  createCase(@Body() dto: CreateCommissionCaseDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.createCase(dto, user);
  }

  @Post('cases/:id/deliberate')
  @Privileges('decide')
  @ApiOperation({ summary: 'Passage en délibéré (A_INSTRUIRE -> EN_DELIBERE)' })
  deliberate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.deliberate(id, user);
  }

  @Post('cases/:id/decide')
  @Privileges('decide')
  @ApiOperation({ summary: 'Prononcé de la décision de commission (EN_DELIBERE -> PRONONCE)' })
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideCommissionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.decide(id, dto, user);
  }

  @Post('cases/:id/penalty')
  @Privileges('penaltyOrder')
  @ApiOperation({ summary: 'Proposition de pénalité financière (plafonnée) à l’encontre d’une partie — exige une décision prononcée au PV signé ; prononcée après contreseing (POST /commission/sanctions/:id/countersign)' })
  penalty(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PenaltyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.penalty(id, dto, user);
  }

  @Post('cases/:id/sanction')
  @Privileges('sanction')
  @ApiOperation({ summary: 'Proposition de sanction (avertissement/suspension) à l’encontre d’une partie — exige une décision prononcée au PV signé ; une seule par (dossier, compagnie, type) ; prononcée après contreseing' })
  sanction(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SanctionOrderDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.sanction(id, dto, user);
  }

  @Post('sanctions/:id/countersign')
  @Privileges('sanction', 'penaltyOrder')
  @ApiOperation({ summary: 'Contreseing d’une pénalité/sanction par un second membre (409 si c’est son auteur ou si elle est déjà prononcée)' })
  countersign(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.countersignSanction(id, user);
  }

  @Post('cases/:id/pv-sign')
  @Privileges('pvSign')
  @ApiOperation({ summary: 'Signature du PV de commission après le prononcé, par un autre membre que l’auteur du prononcé ; une seule fois (409), référence générée par le serveur' })
  pvSign(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.pvSign(id, user);
  }

  @Get('sanctions')
  // SEC-43 : lecture scopée par compagnie partie au dossier dans le service
  @Authenticated()
  @ApiOperation({ summary: 'Registre des pénalités/sanctions, paginé (6/p, 100 max), filtrable par compagnie et statut (B.7 : scopé par compagnie)' })
  listSanctions(@Query() q: ListSanctionsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listSanctions(q, user);
  }

  @Get('summary')
  // SEC-43 : lecture scopée par compagnie partie au dossier dans le service
  @Authenticated()
  @ApiOperation({ summary: 'KPI de synthèse : dossiers pendants, hors délai 15j (Art.24), recours jugés fondés, oppositions fondées Art.12 (B.7 : scopé par compagnie)' })
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.service.summary(user);
  }
}
