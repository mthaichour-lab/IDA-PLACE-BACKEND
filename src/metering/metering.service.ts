import { Injectable } from '@nestjs/common';

export interface PriceGridMetric {
  metric: string;
  label: string;
  unit: string;
  includedQuota: number;
  unitPrice: number;
}

export interface PriceGrid {
  version: string;
  effectiveFrom: string;
  subscription: { label: string; monthly: number };
  metrics: PriceGridMetric[];
}

/** Grille tarifaire TARIF-2026.01 — valeurs réelles du dossier (§B.8). Mutable en mémoire (mock persistance, hors périmètre de ce sprint). */
let PRICE_GRID: PriceGrid = {
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
 * MeteringService — service public du MeteringModule (B.8). Extrait du
 * contrôleur (ce sprint) pour que d'autres modules réutilisent la grille
 * tarifaire TARIF-2026.01 réelle (ex: `SettlementModule`, §2 de la mission)
 * SANS importer d'entité interne (MeteringModule n'en a aucune — la grille
 * reste un mock mutable en mémoire, hors périmètre de ce sprint, voir
 * HANDOFF.md). `MeteringController` délègue désormais à ce service — forme
 * des routes `GET /pricing/grid`, `PUT /pricing/grid`, `GET /metering/...`
 * inchangée.
 */
@Injectable()
export class MeteringService {
  getGrid(): PriceGrid {
    return PRICE_GRID;
  }

  /**
   * Fusionne par clé plutôt que de remplacer en bloc : un payload partiel
   * (ex. un seul inducteur de `metrics`, ou `subscription` sans `metrics`)
   * ne doit JAMAIS faire disparaître le reste de la grille. Bug trouvé en
   * revue Testeur, sprint 3 : `{ ...PRICE_GRID, ...patch }` remplaçait tout
   * le tableau `metrics` dès qu'il était présent dans le payload, même
   * partiel — risque de verrouillage de place (grille + matrice de rôles
   * partagent le même défaut, voir `AdminController.putRolesMatrix`).
   */
  updateGrid(patch: Partial<PriceGrid>): PriceGrid {
    const metrics = patch.metrics
      ? PRICE_GRID.metrics.map((m) => {
          const update = patch.metrics!.find((p) => p.metric === m.metric);
          return update ? { ...m, ...update } : m;
        })
      : PRICE_GRID.metrics;
    PRICE_GRID = {
      ...PRICE_GRID,
      ...patch,
      subscription: patch.subscription ? { ...PRICE_GRID.subscription, ...patch.subscription } : PRICE_GRID.subscription,
      metrics,
    };
    return PRICE_GRID;
  }

  /** Prix unitaire d'une métrique de la grille courante (0 si inconnue — ne doit jamais lever pour un calcul dérivé non bloquant). */
  unitPrice(metric: string): number {
    return PRICE_GRID.metrics.find((m) => m.metric === metric)?.unitPrice ?? 0;
  }
}
