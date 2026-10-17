import { Body, Controller, Get, Module, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Privileges } from '../common/decorators/privileges.decorator';
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
  constructor(private readonly service: MeteringService) {}

  @Get('metering/:company/:period')
  @ApiOperation({ summary: 'Consommation + facture mensuelle réconciliable (mock, calcul basé sur TARIF-2026.01)' })
  get(@Param('company') company: string, @Param('period') period: string) {
    const grid = this.service.getGrid();
    const measured: Record<string, number> = {
      apiCalls: 182000, claimsIngested: 710, matchings: 650, storageGB: 72,
      bandwidthGB: 55, ocrPages: 5200, sms: 4100, emails: 12400,
      activeUsers: 28, cpuHours: 430, memGBh: 2100, backupsGB: 58,
    };
    const lines = grid.metrics.map((m) => {
      const mesure = measured[m.metric] ?? 0;
      const facturable = Math.max(0, mesure - m.includedQuota);
      const divider = m.unit.startsWith('1 000') ? 1000 : m.unit.startsWith('100 ') ? 100 : 1;
      const amount = Math.round((facturable / divider) * m.unitPrice);
      return { ...m, measured: mesure, facturable, amount };
    });
    const totalHT = grid.subscription.monthly + lines.reduce((s, l) => s + l.amount, 0);
    return {
      company, period, gridVersion: grid.version,
      subscription: grid.subscription, lines,
      totalHT, totalTVA: Math.round(totalHT * 0.19), totalTTC: Math.round(totalHT * 1.19),
      status: 'EMISE',
    };
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

@Module({ controllers: [MeteringController], providers: [MeteringService], exports: [MeteringService] })
export class MeteringModule {}
