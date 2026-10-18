import { Body, Controller, Get, Module, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AdherentsModule } from '../adherents/adherents.module';
import { AdherentsService } from '../adherents/adherents.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { MeteringService, PriceGrid } from './metering.service';

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

  @Get('metering/:company/:period')
  @ApiOperation({ summary: 'Consommation + facture mensuelle réconciliable (mock, calcul basé sur TARIF-2026.01)' })
  get(@Param('company') company: string, @Param('period') period: string) {
    const grid = this.service.getGrid();
    const lines = this.service.computeInvoiceLines();
    const totalHT = grid.subscription.monthly + lines.reduce((s, l) => s + l.amount, 0);
    return {
      company, period, gridVersion: grid.version,
      subscription: grid.subscription, lines,
      totalHT, totalTVA: Math.round(totalHT * 0.19), totalTTC: Math.round(totalHT * 1.19),
      status: 'EMISE',
    };
  }

  @Get('metering/place-summary/:period')
  @ApiOperation({
    summary:
      'Dashboard des coûts place entière (écran 14, sous-onglet "Coûts & tarification") — somme de la facture mock de chaque adhérent RÉEL (AdherentsService), jamais un nombre de compagnies inventé',
  })
  async placeSummary(@Param('period') period: string) {
    const { total } = await this.adherents.listCompanies(1, 1);
    return { period, ...this.service.placeSummary(total) };
  }

  @Get('metering/:company/:period/history/:metric')
  @ApiOperation({
    summary:
      'Historique mensuel (10 mois) d’une métrique de consommation — MOCK déterministe, rampe vers la valeur courante (collecte réelle OpenTelemetry/Kubernetes hors périmètre, voir doc de classe)',
  })
  history(@Param('period') period: string, @Param('metric') metric: string) {
    return { metric, points: this.service.history(metric, period) };
  }

  @Get('pricing/grid')
  @ApiOperation({ summary: 'Grille tarifaire courante (TARIF-2026.01)' })
  getGrid() {
    return this.service.getGrid();
  }

  @Put('pricing/grid')
  @Privileges('grid')
  @ApiOperation({ summary: 'Mise à jour de la grille tarifaire (super admin)' })
  // TODO(backend-agent): valider le DTO + persister une nouvelle version (PriceGrid, §B.3) au lieu de muter l'objet en mémoire.
  putGrid(@Body() body: Partial<PriceGrid>) {
    return this.service.updateGrid(body);
  }
}

@Module({ imports: [AdherentsModule], controllers: [MeteringController], providers: [MeteringService], exports: [MeteringService] })
export class MeteringModule {}
