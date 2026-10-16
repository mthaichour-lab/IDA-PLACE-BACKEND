import { Body, Controller, Get, Module, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';

/** Grille tarifaire TARIF-2026.01 — valeurs réelles du dossier (§B.8). Mutable en mémoire (mock persistance). */
let PRICE_GRID = {
  version: 'TARIF-2026.01',
  effectiveFrom: '2026-01-01',
  subscription: { label: 'Abonnement mensuel', monthly: 180000 },
  metrics: [
    { metric: 'apiCalls', label: 'Appels API', unit: '1 000 appels', includedQuota: 150000, unitPrice: 45 },
    { metric: 'claimsIngested', label: 'Dossiers ingérés', unit: 'dossier', includedQuota: 600, unitPrice: 120 },
    { metric: 'matchings', label: 'Matchings effectués', unit: 'matching', includedQuota: 600, unitPrice: 60 },
    { metric: 'storageGB', label: 'Stockage documentaire', unit: 'Go-mois', includedQuota: 60, unitPrice: 85 },
    { metric: 'bandwidthGB', label: 'Bande passante', unit: 'Go', includedQuota: 40, unitPrice: 30 },
    { metric: 'ocrPages', label: 'Traitements OCR / IA', unit: 'page', includedQuota: 4000, unitPrice: 9 },
    { metric: 'sms', label: 'Notifications SMS', unit: 'SMS', includedQuota: 3500, unitPrice: 4.5 },
    { metric: 'emails', label: 'Notifications e-mail', unit: '100 e-mails', includedQuota: 10000, unitPrice: 25 },
    { metric: 'activeUsers', label: 'Utilisateurs actifs', unit: 'utilisateur', includedQuota: 25, unitPrice: 1500 },
    { metric: 'cpuHours', label: 'Temps CPU', unit: 'h vCPU', includedQuota: 400, unitPrice: 14 },
    { metric: 'memGBh', label: 'Mémoire', unit: 'Go·h', includedQuota: 2000, unitPrice: 1.8 },
    { metric: 'backupsGB', label: 'Sauvegardes', unit: 'Go', includedQuota: 50, unitPrice: 20 },
  ],
};

/**
 * MeteringModule — écrans 10 "Métrologie & facturation" et 14
 * (sous-onglet coûts), B.2/B.8.
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
  @Get('metering/:company/:period')
  @ApiOperation({ summary: 'Consommation + facture mensuelle réconciliable (mock, calcul basé sur TARIF-2026.01)' })
  get(@Param('company') company: string, @Param('period') period: string) {
    const measured: Record<string, number> = {
      apiCalls: 182000, claimsIngested: 710, matchings: 650, storageGB: 72,
      bandwidthGB: 55, ocrPages: 5200, sms: 4100, emails: 12400,
      activeUsers: 28, cpuHours: 430, memGBh: 2100, backupsGB: 58,
    };
    const lines = PRICE_GRID.metrics.map((m) => {
      const mesure = measured[m.metric] ?? 0;
      const facturable = Math.max(0, mesure - m.includedQuota);
      const divider = m.unit.startsWith('1 000') ? 1000 : m.unit.startsWith('100 ') ? 100 : 1;
      const amount = Math.round((facturable / divider) * m.unitPrice);
      return { ...m, measured: mesure, facturable, amount };
    });
    const totalHT = PRICE_GRID.subscription.monthly + lines.reduce((s, l) => s + l.amount, 0);
    return {
      company, period, gridVersion: PRICE_GRID.version,
      subscription: PRICE_GRID.subscription, lines,
      totalHT, totalTVA: Math.round(totalHT * 0.19), totalTTC: Math.round(totalHT * 1.19),
      status: 'EMISE',
    };
  }

  @Get('pricing/grid')
  @ApiOperation({ summary: 'Grille tarifaire courante (TARIF-2026.01)' })
  getGrid() {
    return PRICE_GRID;
  }

  @Put('pricing/grid')
  @Privileges('grid')
  @ApiOperation({ summary: 'Mise à jour de la grille tarifaire (super admin)' })
  // TODO(backend-agent): valider le DTO + persister une nouvelle version (PriceGrid, §B.3) au lieu de muter l'objet en mémoire.
  putGrid(@Body() body: typeof PRICE_GRID) {
    PRICE_GRID = { ...PRICE_GRID, ...body };
    return PRICE_GRID;
  }
}

@Module({ controllers: [MeteringController] })
export class MeteringModule {}
