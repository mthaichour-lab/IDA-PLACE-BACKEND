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
 * Consommation mesurée (B.8) — **MOCK explicitement hors périmètre**
 * (collecte réelle OpenTelemetry/Kubernetes non branchée, voir
 * `metering.module.ts`). Extrait ici (plutôt que recréé dans chaque
 * endpoint) pour que `get()` et `history()` restent cohérents entre eux —
 * un bug de cohérence trouvé en préparant l'historique mensuel (2026-10-18) :
 * le contrôleur recréait ce même objet localement, un futur ajout aurait pu
 * diverger entre les deux routes sans qu'on s'en aperçoive.
 */
export const MOCK_MEASURED_CONSUMPTION: Record<string, number> = {
  apiCalls: 182000,
  claimsIngested: 710,
  matchings: 650,
  storageGB: 72,
  bandwidthGB: 55,
  ocrPages: 5200,
  sms: 4100,
  emails: 12400,
  activeUsers: 28,
  cpuHours: 430,
  memGBh: 2100,
  backupsGB: 58,
};

/**
 * Historique mensuel synthétique d'une métrique (écran 10, guide illustré
 * — graphe "Consommation mensuelle") — **MOCK**, déterministe (pas
 * aléatoire : mêmes entrées ⇒ mêmes valeurs à chaque appel, important pour
 * les tests et pour ne pas donner l'illusion d'un vrai flux temps réel).
 * Rampe linéaire de 55% à 100% de la valeur mesurée courante sur
 * `monthsCount - 1` mois, le dernier mois (courant, partiel) à 45% — même
 * esprit que le reste de ce module (mock clairement documenté, cohérent
 * avec TARIF-2026.01), PAS une vraie série temporelle (aucune collecte
 * réelle, voir tête de fichier).
 */
export function buildMeasuredHistory(currentValue: number, periodEndingAt: string, monthsCount = 10): { period: string; value: number }[] {
  const [y, m] = periodEndingAt.split('-').map(Number);
  const points: { period: string; value: number }[] = [];
  for (let i = monthsCount - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const isCurrent = i === 0;
    const ratio = isCurrent ? 0.45 : 0.55 + (0.45 * (monthsCount - 1 - i)) / Math.max(1, monthsCount - 2);
    points.push({ period, value: Math.round(currentValue * Math.min(ratio, 1)) });
  }
  return points;
}

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

  /** Mesure mocquée courante d'une métrique (0 si inconnue) — voir `MOCK_MEASURED_CONSUMPTION`. */
  measuredFor(metric: string): number {
    return MOCK_MEASURED_CONSUMPTION[metric] ?? 0;
  }

  history(metric: string, period: string, monthsCount = 10): { period: string; value: number }[] {
    return buildMeasuredHistory(this.measuredFor(metric), period, monthsCount);
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
