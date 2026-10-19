import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Authenticated } from '../common/decorators/access.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { PLACE_LEVEL_ROLES } from '../common/rbac/roles-privileges';
import { AdherentsService } from './adherents.service';
import { CreateAgencyDto, ListAgenciesQueryDto, UpdateAgencyDto } from './dto/agency.dto';
import { CreateCompanyDto, ReferentialPageQueryDto, UpdateCompanyDto, UpdateCompanyGovernanceDto } from './dto/company.dto';
import { CalendarQueryDto } from './dto/place-referential.dto';

/**
 * Référentiel de place — écran 12. Routes exposées sous `/referential/*`
 * conformément à B.11 (`GET /api/v1/referential/companies|agencies|experts`).
 *
 * Revue sécurité 2026-10-19 : SEC-04 (gouvernance d'une compagnie à quatre
 * yeux), SEC-26 (projection minimale des concurrentes, agences filtrées par
 * compagnie), SEC-31 (hiérarchie des agences), SEC-44 (identifiants et
 * requêtes typés, pagination bornée).
 */
@ApiTags('referential')
@ApiBearerAuth()
@Controller('referential')
export class AdherentsController {
  constructor(private readonly service: AdherentsService) {}

  @Get('companies')
  // SEC-43 : lecture scopée dans le service (projection publique des concurrentes, SEC-26)
  @Authenticated()
  @ApiOperation({ summary: 'Liste paginée des compagnies adhérentes (6/p, 100 max) — un rôle compagnie reçoit la projection publique de ses concurrentes (SEC-26)' })
  listCompanies(@Query() q: ReferentialPageQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listCompanies(q.page, q.pageSize, user);
  }

  @Get('companies/:id')
  // SEC-43 : lecture scopée dans le service (projection publique des concurrentes, SEC-26)
  @Authenticated()
  @ApiOperation({ summary: "Fiche compagnie (identité, code, couleur, mode d'alimentation, clé API masquée) — projection publique pour une concurrente (SEC-26)" })
  getCompany(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getCompany(id, user);
  }

  // QUESTIONS_UAR.md §12 : onboarding réservé au privilège `onboardCompany` (rôles place).
  @Post('companies')
  @Privileges('onboardCompany')
  @ApiOperation({ summary: 'Création d’une compagnie adhérente — réservé aux rôles "place" (QUESTIONS_UAR.md §12)' })
  createCompany(@Body() dto: CreateCompanyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.createCompany(dto, user);
  }

  @Put('companies/:id')
  @Privileges('refedit')
  @ApiOperation({
    summary:
      "Mise à jour du PROFIL d'une compagnie (B.7 : un CORRESPONDANT_IDA ne modifie que SA compagnie). SEC-04 : statut, délais dérogatoires, nature et mode d'alimentation → 403 GOUVERNANCE_RESERVEE (voir /governance-changes)",
  })
  updateCompany(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCompanyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.updateCompany(id, dto, user);
  }

  @Get('companies/:id/governance-changes')
  // SEC-43 : rôles de place (le service le vérifie aussi)
  @Roles(...PLACE_LEVEL_ROLES)
  @ApiOperation({ summary: 'SEC-04 — demandes de changement de gouvernance d’une compagnie (rôles place)' })
  listGovernanceChanges(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listGovernanceChanges(id, user);
  }

  @Post('companies/:id/governance-changes')
  @Privileges('validateRef')
  @ApiOperation({ summary: 'SEC-04 — demande de changement de gouvernance (statut, délais, nature, alimentation) par un Admin UAR, motif obligatoire ; sans effet avant validation' })
  requestGovernanceChange(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCompanyGovernanceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.requestGovernanceChange(id, dto, user);
  }

  @Post('companies/:id/governance-changes/:changeId/validate')
  @Privileges('validateRef')
  @ApiOperation({ summary: 'SEC-04 — validation par un SECOND Admin UAR (quatre yeux : 409 si c’est l’auteur) : changement appliqué et scellé au journal (auteur + valideur)' })
  validateGovernanceChange(@Param('id', ParseUUIDPipe) id: string, @Param('changeId', ParseUUIDPipe) changeId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.decideGovernanceChange(id, changeId, 'VALIDEE', user);
  }

  @Post('companies/:id/governance-changes/:changeId/reject')
  @Privileges('validateRef')
  @ApiOperation({ summary: 'SEC-04 — rejet par un second Admin UAR (quatre yeux), scellé au journal' })
  rejectGovernanceChange(@Param('id', ParseUUIDPipe) id: string, @Param('changeId', ParseUUIDPipe) changeId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.decideGovernanceChange(id, changeId, 'REJETEE', user);
  }

  @Get('agencies')
  // SEC-43 : lecture scopée par compagnie dans le service (SEC-26)
  @Authenticated()
  @ApiOperation({ summary: 'Liste paginée des agences (filtrable par compagnie) — un rôle compagnie ne voit que SES agences (SEC-26)' })
  listAgencies(@Query() q: ListAgenciesQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listAgencies(q.page, q.pageSize, q.companyId, user);
  }

  @Post('agencies')
  @Privileges('refedit')
  @ApiOperation({ summary: "Création d'une agence (B.7 : uniquement pour SA propre compagnie ; SEC-31 : agence parente de la même compagnie)" })
  createAgency(@Body() dto: CreateAgencyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.createAgency(dto, user);
  }

  @Put('agencies/:id')
  @Privileges('refedit')
  @ApiOperation({ summary: "Mise à jour d'une agence (B.7 : uniquement une agence de SA propre compagnie ; SEC-31 : parent de la même compagnie, sans cycle)" })
  updateAgency(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAgencyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.updateAgency(id, dto, user);
  }

  @Get('wilayas')
  // SEC-43 : référentiel commun de la place (lecture, non confidentiel)
  @Authenticated()
  @ApiOperation({ summary: '69 wilayas (référentiel, grille de tuiles 13×8 — écran 11)' })
  @ApiOkResponse()
  listWilayas() {
    return this.service.listWilayas();
  }

  @Get('convention')
  // SEC-43 : référentiel commun de la place (lecture, non confidentiel)
  @Authenticated()
  @ApiOperation({ summary: 'Paramètres réels de la convention (délais Art.10/12/19, plafond Art.4) — mêmes valeurs que RecoursModule/EligibilityModule, jamais dupliquées' })
  getConvention() {
    return this.service.getConventionParams();
  }

  @Get('calendar')
  // SEC-43 : référentiel commun de la place (lecture, non confidentiel)
  @Authenticated()
  @ApiOperation({
    summary:
      'Week-end légal algérien, fériés à date fixe et `holidays` : union fixes + mobiles (prévisionnels et confirmés) avec leur statut, bornée par from/to inclus (décision PO §2)',
  })
  async getCalendar(@Query() q: CalendarQueryDto) {
    return { ...this.service.getCalendar(), holidays: await this.service.calendarHolidays(q.from, q.to) };
  }

  @Get('motifs')
  // SEC-43 : référentiel commun de la place (lecture, non confidentiel)
  @Authenticated()
  @ApiOperation({ summary: "Catalogue réel des motifs d'inéligibilité (articles 3/4/5-6/13/19/28), extrait de eligibility.rules.ts" })
  getMotifs() {
    return this.service.getMotifs();
  }
}
