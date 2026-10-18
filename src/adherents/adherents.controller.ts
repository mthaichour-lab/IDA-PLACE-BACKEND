import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Privileges } from '../common/decorators/privileges.decorator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AdherentsService } from './adherents.service';
import { CreateAgencyDto, UpdateAgencyDto } from './dto/agency.dto';
import { CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';

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

  @Post('companies')
  @Privileges('refedit')
  @ApiOperation({ summary: 'Création d’une compagnie adhérente' })
  createCompany(@Body() dto: CreateCompanyDto) {
    return this.service.createCompany(dto);
  }

  @Put('companies/:id')
  @Privileges('refedit')
  @ApiOperation({ summary: 'Mise à jour d’une compagnie adhérente' })
  updateCompany(@Param('id') id: string, @Body() dto: UpdateCompanyDto) {
    return this.service.updateCompany(id, dto);
  }

  @Get('agencies')
  @ApiOperation({ summary: 'Liste paginée des agences (filtrable par compagnie)' })
  listAgencies(@Query() q: PaginationQueryDto, @Query('companyId') companyId?: string) {
    return this.service.listAgencies(q.page, q.pageSize, companyId);
  }

  @Post('agencies')
  @Privileges('refedit')
  @ApiOperation({ summary: 'Création d’une agence' })
  createAgency(@Body() dto: CreateAgencyDto) {
    return this.service.createAgency(dto);
  }

  @Put('agencies/:id')
  @Privileges('refedit')
  @ApiOperation({ summary: 'Mise à jour d’une agence' })
  updateAgency(@Param('id') id: string, @Body() dto: UpdateAgencyDto) {
    return this.service.updateAgency(id, dto);
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
  @ApiOperation({ summary: 'Week-end légal algérien + jours fériés à date fixe 2026-2027 (jours fériés religieux à date mobile volontairement absents, voir referential-reference-data.ts)' })
  getCalendar() {
    return this.service.getCalendar();
  }

  @Get('motifs')
  @ApiOperation({ summary: "Catalogue réel des motifs d'inéligibilité (articles 3/4/5-6/13/19/28), extrait de eligibility.rules.ts" })
  getMotifs() {
    return this.service.getMotifs();
  }
}
