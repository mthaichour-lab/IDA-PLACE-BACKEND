import { Body, Controller, Get, Module, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AdherentsModule } from '../adherents/adherents.module';
import { AdherentsService } from '../adherents/adherents.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { assertCompanyAccess } from '../common/rbac/tenant-scope';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { LedgerModule } from '../ledger/ledger.module';
import { MeteringHistoryParamsDto, MeteringInvoiceParamsDto, MeteringPeriodParamDto, UpdatePriceGridDto } from './dto/metering.dto';
import { PriceGridVersion } from './entities/price-grid-version.entity';
import { MeteringService } from './metering.service';
import { Roles } from '../common/decorators/roles.decorator';
import { PLACE_LEVEL_ROLES } from '../common/rbac/roles-privileges';

/**
 * MeteringModule — écrans 10 "Métrologie & facturation" et 14
 * (sous-onglet coûts), B.2/B.8.
 *
 * Grille tarifaire TARIF-2026.01 réelle (valeurs du dossier), désormais
 * exposée par `MeteringService` (service public réutilisable par d'autres
 * modules, ex: `SettlementModule`, §2 de la mission) plutôt qu'enfermée
 * dans le contrôleur. Routes et formes de réponse INCHANGÉES.
 *
 * TODO(backend-agent): voir §B.8, collecter la consommation réelle (labels
 * Kubernetes par tenant + OpenTelemetry), persister `Metering`/`Invoice`
 * (entités + migration), calculer `facturable = max(0, mesuré - quota)` et
 * générer la facture réconciliable réelle + showback d'infrastructure.
 */
@ApiTags('metering')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard, PrivilegesGuard)
class MeteringController {
  constructor(
    private readonly service: MeteringService,
    private readonly adherents: AdherentsService,
  ) {}

  // ⚠️ ORDRE DES ROUTES IMPORTANT : `place-summary/:period` DOIT être
  // déclarée AVANT `:company/:period` — sinon Nest/Express matche la route
  // générique en premier (`company` capturé = littéralement "place-summary"),
  // et cette route spécifique n'est JAMAIS atteinte. Bug réel trouvé en
  // vérification navigateur (2026-10-18) : le dashboard affichait "NaN DZD"
  // partout, la réponse reçue était silencieusement celle de `get()` avec
  // `company: "place-summary"`.
  // SEC-26 : chiffre d'affaires de l'opérateur, place entière — réservé aux
  // rôles place (TRESORIER détient `bill` mais reste un rôle compagnie).
  @Get('metering/place-summary/:period')
  @Roles(...PLACE_LEVEL_ROLES)
  @ApiOperation({
    summary:
      'Dashboard des coûts place entière (écran 14, sous-onglet "Coûts & tarification") — SIMULÉ (refusé en production, SEC-37), réservé aux rôles place (SEC-26)',
  })
  async placeSummary(@Param() p: MeteringPeriodParamDto) {
    this.service.assertSimulationAllowed();
    const { total } = await this.adherents.listCompanies(1, 1);
    return { period: p.period, ...this.service.placeSummary(total, await this.service.gridFor(p.period)) };
  }

  // Revue sécurité 2026-10-18 (B.7) : `assertCompanyAccess` — une compagnie
  // ne consulte que SA facturation (SEC-38 : refus côté serveur, pas
  // seulement dans l'interface). SEC-37 : facture SIMULÉE (consommation
  // mockée) marquée `SIMULEE`, jamais `EMISE`, et refusée en production.
  @Get('metering/:company/:period')
  @ApiOperation({ summary: 'Consommation + facture mensuelle SIMULÉE (grille en vigueur sur la période) — B.7 : scopée par compagnie ; 503 en production (SEC-37)' })
  async get(@Param() p: MeteringInvoiceParamsDto, @CurrentUser() user: AuthenticatedUser) {
    assertCompanyAccess(user, p.company);
    this.service.assertSimulationAllowed();
    const grid = await this.service.gridFor(p.period);
    const lines = this.service.computeInvoiceLines(grid);
    const totalHT = grid.subscription.monthly + lines.reduce((s, l) => s + l.amount, 0);
    return {
      company: p.company, period: p.period, gridVersion: grid.version,
      subscription: grid.subscription, lines,
      totalHT, totalTVA: Math.round(totalHT * 0.19), totalTTC: Math.round(totalHT * 1.19),
      status: 'SIMULEE',
      simulated: true,
    };
  }

  @Get('metering/:company/:period/history/:metric')
  @ApiOperation({
    summary:
      'Historique mensuel (10 mois) d’une métrique de consommation — SIMULÉ (rampe déterministe), métrique de la grille uniquement (400 sinon) — B.7 : scopée par compagnie ; 503 en production',
  })
  history(@Param() p: MeteringHistoryParamsDto, @CurrentUser() user: AuthenticatedUser) {
    assertCompanyAccess(user, p.company);
    this.service.assertSimulationAllowed();
    return { metric: p.metric, points: this.service.history(p.metric, p.period), simulated: true };
  }

  @Get('pricing/grid')
  @ApiOperation({ summary: 'Grille tarifaire en vigueur aujourd’hui (versionnée, SEC-37)' })
  getGrid() {
    return this.service.gridFor();
  }

  // SEC-37 : DTO strict (bornes, liste blanche des métriques, version et date
  // d'effet obligatoires) ; crée une nouvelle version persistée et scellée,
  // jamais rétroactive. SEC-38 : 403 côté serveur sans le privilège `grid`.
  @Put('pricing/grid')
  @Privileges('grid')
  @ApiOperation({ summary: 'Nouvelle version de la grille tarifaire à date d’effet (super admin) — 400 si invalide ou rétroactive, 409 si la version existe' })
  putGrid(@Body() body: UpdatePriceGridDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.updateGrid(body, user);
  }
}

@Module({
  imports: [MikroOrmModule.forFeature([PriceGridVersion]), AdherentsModule, LedgerModule],
  controllers: [MeteringController],
  providers: [MeteringService],
  exports: [MeteringService],
})
export class MeteringModule {}
