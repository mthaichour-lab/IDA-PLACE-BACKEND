import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { AdherentsService } from './adherents.service';
import { CreateAgencyDto, UpdateAgencyDto } from './dto/agency.dto';
import { CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';
import { CalendarQueryDto } from './dto/place-referential.dto';

/**
 * Référentiel de place — écran 12. Routes exposées sous `/referential/*`
 * conformément à B.11 (`GET /api/v1/referential/companies|agencies|experts`).
 */
@ApiTags('referential')
@ApiBearerAuth()
@Controller('referential')
@UseGuards(AuthGuard, PrivilegesGuard)
export class AdherentsController {
  constructor(private readonly service: AdherentsService) {}

  @Get('companies')
  @ApiOperation({ summary: 'Liste paginée des compagnies adhérentes (6/p)' })
  listCompanies(@Query() q: PaginationQueryDto) {
    return this.service.listCompanies(q.page, q.pageSize);
  }

  @Get('companies/:id')
  @ApiOperation({ summary: "Fiche compagnie (identité, code, couleur, mode d'alimentation, clé API masquée)" })
  getCompany(@Param('id') id: string) {
    return this.service.getCompany(id);
  }

  // QUESTIONS_UAR.md §12, décision Product Owner 2026-10-18 : l'onboarding
  // d'une NOUVELLE compagnie adhérente n'a pas de "propriétaire existant" à
  // vérifier (contrairement à updateCompany/createAgency/experts,
  // restreints à SA PROPRE compagnie via `refedit`) — réservé aux rôles
  // "place" (OPERATEUR_PLACE/ADMIN_UAR), privilège `onboardCompany` dédié.
  // `refedit` reste inchangé pour toutes les autres routes ci-dessous.
  @Post('companies')
  @Privileges('onboardCompany')
  @ApiOperation({ summary: 'Création d’une compagnie adhérente — réservé aux rôles "place" (QUESTIONS_UAR.md §12)' })
  createCompany(@Body() dto: CreateCompanyDto) {
    return this.service.createCompany(dto);
  }

  @Put('companies/:id')
  @Privileges('refedit')
  @ApiOperation({ summary: "Mise à jour d'une compagnie adhérente (B.7 : un CORRESPONDANT_IDA ne peut modifier que SA propre compagnie)" })
  updateCompany(@Param('id') id: string, @Body() dto: UpdateCompanyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.updateCompany(id, dto, user);
  }

  @Get('agencies')
  @ApiOperation({ summary: 'Liste paginée des agences (filtrable par compagnie)' })
  listAgencies(@Query() q: PaginationQueryDto, @Query('companyId') companyId?: string) {
    return this.service.listAgencies(q.page, q.pageSize, companyId);
  }

  @Post('agencies')
  @Privileges('refedit')
  @ApiOperation({ summary: "Création d'une agence (B.7 : uniquement pour SA propre compagnie)" })
  createAgency(@Body() dto: CreateAgencyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.createAgency(dto, user);
  }

  @Put('agencies/:id')
  @Privileges('refedit')
  @ApiOperation({ summary: "Mise à jour d'une agence (B.7 : uniquement une agence de SA propre compagnie)" })
  updateAgency(@Param('id') id: string, @Body() dto: UpdateAgencyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.updateAgency(id, dto, user);
  }

  @Get('wilayas')
  @ApiOperation({ summary: '69 wilayas (référentiel, grille de tuiles 13×8 — écran 11)' })
  @ApiOkResponse()
  listWilayas() {
    return this.service.listWilayas();
  }

  @Get('convention')
  @ApiOperation({ summary: 'Paramètres réels de la convention (délais Art.10/12/19, plafond Art.4) — mêmes valeurs que RecoursModule/EligibilityModule, jamais dupliquées' })
  getConvention() {
    return this.service.getConventionParams();
  }

  @Get('calendar')
  @ApiOperation({
    summary:
      'Week-end légal algérien, fériés à date fixe et `holidays` : union fixes + mobiles (prévisionnels et confirmés) avec leur statut, bornée par from/to inclus (décision PO §2)',
  })
  async getCalendar(@Query() q: CalendarQueryDto) {
    return { ...this.service.getCalendar(), holidays: await this.service.calendarHolidays(q.from, q.to) };
  }

  @Get('motifs')
  @ApiOperation({ summary: "Catalogue réel des motifs d'inéligibilité (articles 3/4/5-6/13/19/28), extrait de eligibility.rules.ts" })
  getMotifs() {
    return this.service.getMotifs();
  }
}
