import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { CompletePipelineStepDto } from './dto/settlement-pipeline.dto';
import { CloseMonthlyDto } from './dto/settlement.dto';
import { SettlementPipelineService } from './settlement-pipeline.service';
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
  constructor(
    private readonly service: SettlementService,
    private readonly pipelineService: SettlementPipelineService,
  ) {}

  @Get('monthly/:period')
  @ApiOperation({ summary: 'Synthèse mensuelle par compagnie (ex: period=2026-01) — état d’avancement réel, à partir des recours (B.7 : scopée par compagnie)' })
  monthly(@Param('period') period: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.monthly(period, user);
  }

  @Get('monthly/:period/summary')
  @ApiOperation({ summary: 'KPI de synthèse du cycle mensuel : recours réglés intégrés, montant, oppositions exclues (RG-06), échéance de saisie (B.7 : scopée par compagnie)' })
  monthlySummary(@Param('period') period: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.monthlySummary(period, user);
  }

  @Get('monthly/:period/annexe7')
  @ApiOperation({ summary: 'Synthèse Annexe 7 — regroupement des recours réglés du mois par paire créancier→débiteur, sans netting (B.7 : scopée par compagnie)' })
  annexe7(@Param('period') period: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.annexe7(period, user);
  }

  @Post('monthly/:period/close')
  @Privileges('synth')
  @ApiOperation({ summary: 'Clôture de la synthèse mensuelle d’une compagnie et génération du bordereau (409 si déjà clôturée ou si le mois n’est pas échu) ; instantané figé et scellé au journal' })
  closeMonthly(@Param('period') period: string, @Body() dto: CloseMonthlyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.closeMonthly(period, dto.company, user.name, user);
  }

  // ⚠️ ORDRE DES ROUTES IMPORTANT : `quarter/closures` DOIT être déclarée
  // AVANT `quarter/:q` — sinon Nest/Express matche la route générique en
  // premier (`q` capturé = littéralement "closures"), et cette route
  // spécifique n'est JAMAIS atteinte (même piège déjà trouvé et documenté
  // sur `metering.module.ts`, `place-summary/:period` vs `:company/:period`).
  @Get('quarter/closures')
  @ApiOperation({
    summary:
      'Liste de TOUTES les clôtures trimestrielles enregistrées (place entière, toutes périodes) — écran 4 "Échanges Annexes 2/3/4", pour distinguer côté frontend "Accepté/silence" (trimestre du recours réglé pas encore clôturé) de "Réglé/compensé" (trimestre déjà clôturé)',
  })
  quarterlyClosures(@CurrentUser() user: AuthenticatedUser) {
    return this.service.quarterlyClosures(user);
  }

  @Get('quarter/:q')
  @ApiOperation({ summary: 'Compensation trimestrielle — positions bilatérales nettées et compensation multilatérale (ex: q=2026-Q1) (B.7 : scopée par compagnie)' })
  quarter(@Param('q') q: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.quarter(q, user);
  }

  @Get('quarter/:q/matrix')
  @ApiOperation({ summary: 'Matrice brute créancier×débiteur du trimestre, avant tout netting — pour la carte thermique (B.7 : scopée par compagnie)' })
  matrix(@Param('q') q: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.matrix(q, user);
  }

  @Get('quarter/:q/summary')
  @ApiOperation({ summary: 'KPI de synthèse du trimestre : brut, net bilatéral, net multilatéral, réduction des flux, recours réglés/en opposition (B.7 : scopée par compagnie)' })
  summary(@Param('q') q: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.summary(q, user);
  }

  @Get('quarter/:q/pipeline')
  @ApiOperation({ summary: 'Avancement du lot trimestriel (Diagramme 2, Art. 16-18) : 5 étapes, échéances, retards — mêmes droits de lecture que GET /settlement/quarter/:q (SEC-26 : sans auteur ni note pour les rôles compagnie)' })
  pipeline(@Param('q') q: string, @CurrentUser() user: AuthenticatedUser) {
    return this.pipelineService.pipeline(q, user);
  }

  // Pipeline place-entière, comme la clôture trimestrielle : mêmes rôles (§11).
  @Post('quarter/:q/pipeline/:step/complete')
  @Privileges('closeQuarter')
  @ApiOperation({ summary: "Réalisation d'une étape 1 à 4 du lot trimestriel, dans l'ordre (409 si déjà faite ou si l'étape précédente ne l'est pas) — l'étape 5 découle de la clôture trimestrielle" })
  completePipelineStep(@Param('q') q: string, @Param('step') step: string, @Body() dto: CompletePipelineStepDto, @CurrentUser() user: AuthenticatedUser) {
    return this.pipelineService.completeStep(q, step, user, dto.note);
  }

  // QUESTIONS_UAR.md §11, décision Product Owner 2026-10-18 : action
  // place-entière et irréversible (pas de paramètre compagnie, contrairement
  // à `closeMonthly` ci-dessus) — réservée aux rôles "place"
  // (OPERATEUR_PLACE/ADMIN_UAR/MEMBRE_COMMISSION), privilège `closeQuarter`
  // dédié. `synth` reste inchangé pour toutes les routes de LECTURE
  // ci-dessus (nécessaire à CORRESPONDANT_IDA/TRESORIER).
  @Post('quarter/:q/close')
  @Privileges('closeQuarter')
  @ApiOperation({
    summary:
      "Clôture de la compensation trimestrielle et génération du bordereau (409 si déjà clôturée, si le trimestre n'est pas échu ou si les étapes 1 à 4 de l'avancement du lot ne sont pas réalisées) — réservé aux rôles « place » (QUESTIONS_UAR.md §11) ; instantané figé et scellé au journal",
  })
  async closeQuarter(@Param('q') q: string, @CurrentUser() user: AuthenticatedUser) {
    await this.pipelineService.assertReadyToClose(q);
    return this.service.closeQuarterly(q, user);
  }
}
