import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { ConventionReferentialService } from './convention-referential.service';
import {
  ConfirmMobileHolidayDto,
  CreateIrsamBenchmarkDto,
  CreateMobileHolidayDto,
  CreateOppositionMotifDto,
  CreateWilayaPopulationDto,
  ListMobileHolidaysQueryDto,
  ListWilayaPopulationsQueryDto,
  UpdateConstatCircumstanceDto,
  UpdateMobileHolidayDto,
  UpdateOppositionMotifDto,
  UpdateWilayaPerimeterDto,
  UpdateWilayaPopulationDto,
} from './dto/place-referential.dto';
import { PlaceMetricsReferentialService } from './place-metrics-referential.service';
import { MOBILE_HOLIDAY_KIND_LABELS, MOBILE_HOLIDAY_KINDS } from './place-referential.data';

/**
 * Référentiels de place — écran 12, décisions PO points 1 à 4. Lecture : tous
 * les profils. Saisie : `params`. Validation UAR : `validateRef` (ADMIN_UAR).
 */
@ApiTags('referential')
@ApiBearerAuth()
@Controller('referential')
@UseGuards(AuthGuard, PrivilegesGuard)
export class PlaceReferentialController {
  constructor(
    private readonly convention: ConventionReferentialService,
    private readonly metrics: PlaceMetricsReferentialService,
  ) {}

  // ---- Fériés mobiles (§2) ----------------------------------------------

  @Get('mobile-holiday-kinds')
  @ApiOperation({ summary: 'Types de fériés mobiles (loi 63-278 modifiée) — aucune date pré-remplie' })
  mobileHolidayKinds() {
    return MOBILE_HOLIDAY_KINDS.map((kind) => ({ kind, label: MOBILE_HOLIDAY_KIND_LABELS[kind] }));
  }

  @Get('mobile-holidays')
  @ApiOperation({ summary: 'Fériés mobiles saisis (une ligne par jour chômé), filtrables par année' })
  listHolidays(@Query() q: ListMobileHolidaysQueryDto) {
    return this.convention.listHolidays(q.year);
  }

  @Post('mobile-holidays')
  @Privileges('params')
  @ApiOperation({ summary: 'Saisie d’un férié mobile PREVISIONNEL (compte dès sa saisie dans les jours ouvrés)' })
  createHoliday(@Body() dto: CreateMobileHolidayDto, @CurrentUser() user: AuthenticatedUser) {
    return this.convention.createHoliday(dto, user);
  }

  @Put('mobile-holidays/:id')
  @Privileges('params')
  @ApiOperation({ summary: 'Modification d’un férié mobile PREVISIONNEL (409 si confirmé)' })
  updateHoliday(@Param('id') id: string, @Body() dto: UpdateMobileHolidayDto) {
    return this.convention.updateHoliday(id, dto);
  }

  @Post('mobile-holidays/:id/confirm')
  @Privileges('params')
  @ApiOperation({ summary: 'Confirmation PREVISIONNEL → CONFIRME, avec la référence du communiqué ou du décret (date corrigible)' })
  confirmHoliday(@Param('id') id: string, @Body() dto: ConfirmMobileHolidayDto, @CurrentUser() user: AuthenticatedUser) {
    return this.convention.confirmHoliday(id, dto, user);
  }

  @Delete('mobile-holidays/:id')
  @Privileges('params')
  @ApiOperation({ summary: 'Suppression d’un férié mobile PREVISIONNEL (409 si confirmé)' })
  removeHoliday(@Param('id') id: string) {
    return this.convention.removeHoliday(id);
  }

  // ---- Circonstances du constat (§1) ------------------------------------

  @Get('constat-circumstances')
  @ApiOperation({ summary: '17 circonstances du constat amiable (libellé standard CEA, statut STANDARD_A_CONFIRMER tant que non validé UAR)' })
  listCircumstances() {
    return this.convention.listCircumstances();
  }

  @Put('constat-circumstances/:number')
  @Privileges('params')
  @ApiOperation({ summary: 'Modification du libellé FR/AR d’une circonstance (repasse en attente de validation UAR)' })
  updateCircumstance(@Param('number', ParseIntPipe) number: number, @Body() dto: UpdateConstatCircumstanceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.convention.updateCircumstance(number, dto, user);
  }

  @Post('constat-circumstances/:number/validate')
  @Privileges('validateRef')
  @ApiOperation({ summary: 'Validation UAR d’une circonstance (quatre yeux : 409 si le validateur en est l’auteur)' })
  validateCircumstance(@Param('number', ParseIntPipe) number: number, @CurrentUser() user: AuthenticatedUser) {
    return this.convention.validateCircumstance(number, user);
  }

  // ---- Motifs d'opposition (§1) -----------------------------------------

  @Get('opposition-motifs')
  @ApiOperation({ summary: 'Catalogue des motifs d’opposition (Annexe 3) ; `forbidden` = ne peut jamais motiver une opposition' })
  listMotifs() {
    return this.convention.listMotifs();
  }

  @Post('opposition-motifs')
  @Privileges('params')
  @ApiOperation({ summary: 'Ajout d’un motif d’opposition (statut SAISI)' })
  createMotif(@Body() dto: CreateOppositionMotifDto, @CurrentUser() user: AuthenticatedUser) {
    return this.convention.createMotif(dto, user);
  }

  @Put('opposition-motifs/:code')
  @Privileges('params')
  @ApiOperation({ summary: 'Modification d’un motif d’opposition (repasse au statut SAISI)' })
  updateMotif(@Param('code') code: string, @Body() dto: UpdateOppositionMotifDto, @CurrentUser() user: AuthenticatedUser) {
    return this.convention.updateMotif(code, dto, user);
  }

  @Post('opposition-motifs/:code/validate')
  @Privileges('validateRef')
  @ApiOperation({ summary: 'Validation UAR d’un motif d’opposition (quatre yeux : 409 si le validateur en est l’auteur)' })
  validateMotif(@Param('code') code: string, @CurrentUser() user: AuthenticatedUser) {
    return this.convention.validateMotif(code, user);
  }

  // ---- Wilayas / populations (§3) ---------------------------------------

  @Put('wilayas/:code')
  @Privileges('params')
  @ApiOperation({ summary: 'Périmètre d’une wilaya : date d’entrée en vigueur et wilaya mère (null pour effacer)' })
  updateWilayaPerimeter(@Param('code') code: string, @Body() dto: UpdateWilayaPerimeterDto) {
    return this.metrics.updateWilayaPerimeter(code, dto);
  }

  @Get('wilaya-populations')
  @ApiOperation({ summary: 'Populations de référence par wilaya et par année, avec leur validité au regard du périmètre actuel' })
  listPopulations(@Query() q: ListWilayaPopulationsQueryDto) {
    return this.metrics.listPopulations(q.wilayaCode);
  }

  @Post('wilaya-populations')
  @Privileges('params')
  @ApiOperation({ summary: 'Saisie d’une population (source obligatoire ; 400 si antérieure au périmètre actuel, 409 si déjà saisie)' })
  createPopulation(@Body() dto: CreateWilayaPopulationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.metrics.createPopulation(dto, user);
  }

  @Put('wilaya-populations/:id')
  @Privileges('params')
  @ApiOperation({ summary: 'Correction d’une population (valeur, type ou référence de source)' })
  updatePopulation(@Param('id') id: string, @Body() dto: UpdateWilayaPopulationDto) {
    return this.metrics.updatePopulation(id, dto);
  }

  @Post('wilaya-populations/import')
  @Privileges('params')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Import CSV `code;annee;population;source_type;source_ref` — tout ou rien, rapport ligne par ligne' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 1024 * 1024 },
      fileFilter: (_req, file, cb) => cb(null, /\.csv$/i.test(file.originalname)),
    }),
  )
  importPopulations(@UploadedFile() file: { originalname?: string; buffer?: Buffer } | undefined, @CurrentUser() user: AuthenticatedUser) {
    if (!file?.buffer) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Fichier CSV manquant (champ "file", multipart/form-data).' });
    }
    return this.metrics.importPopulations(file.originalname ?? 'populations.csv', file.buffer, user);
  }

  // ---- Référence IRSAM (§4) ---------------------------------------------

  @Get('irsam-benchmarks')
  @ApiOperation({ summary: 'Références IRSAM saisies (toutes, avec leur statut SAISI / VALIDE_UAR / ARCHIVE)' })
  listIrsam() {
    return this.metrics.listIrsam();
  }

  @Post('irsam-benchmarks')
  @Privileges('params')
  @ApiOperation({ summary: 'Saisie d’une référence IRSAM avec sa définition de mesure (statut SAISI, jamais comparée avant validation)' })
  createIrsam(@Body() dto: CreateIrsamBenchmarkDto, @CurrentUser() user: AuthenticatedUser) {
    return this.metrics.createIrsam(dto, user);
  }

  @Post('irsam-benchmarks/:id/validate')
  @Privileges('validateRef')
  @ApiOperation({ summary: 'Validation UAR (quatre yeux) — archive la référence validée précédente du même indicateur' })
  validateIrsam(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.metrics.validateIrsam(id, user);
  }

  @Post('irsam-benchmarks/:id/archive')
  @Privileges('validateRef')
  @ApiOperation({ summary: 'Archivage d’une référence IRSAM (retirée du comparatif)' })
  archiveIrsam(@Param('id') id: string) {
    return this.metrics.archiveIrsam(id);
  }
}
