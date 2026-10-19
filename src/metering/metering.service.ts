import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { LedgerService } from '../ledger/ledger.service';
import { UpdatePriceGridDto } from './dto/metering.dto';
import { PriceGridVersion } from './entities/price-grid-version.entity';

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

/** Grille tarifaire TARIF-2026.01 — valeurs réelles du dossier (§B.8), version de référence (SEC-37 : jamais mutée ; les mises à jour créent de nouvelles versions). */
export const SEED_PRICE_GRID: PriceGrid = {
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

/** Ligne de facture calculée pour une compagnie (mesure simulée × grille). */
export type InvoiceLine = PriceGridMetric & { measured: number; facturable: number; amount: number };

/** Fusion d'un correctif validé (DTO) sur une grille : inducteurs par clé, abonnement champ par champ, jamais d'affectation en bloc. */
export function mergeGrid(base: PriceGrid, patch: UpdatePriceGridDto): PriceGrid {
  const metrics = base.metrics.map((m) => {
    const update = patch.metrics?.find((p) => p.metric === m.metric);
    if (!update) return { ...m };
    return {
      ...m,
      label: update.label ?? m.label,
      unit: update.unit ?? m.unit,
      includedQuota: update.includedQuota ?? m.includedQuota,
      unitPrice: update.unitPrice ?? m.unitPrice,
    };
  });
  return {
    version: patch.version,
    effectiveFrom: patch.effectiveFrom,
    subscription: { label: patch.subscription?.label ?? base.subscription.label, monthly: patch.subscription?.monthly ?? base.subscription.monthly },
    metrics,
  };
}

/** Version en vigueur à une date (AAAA-MM-JJ) : la plus récente dont la date d'effet est atteinte. */
export function gridEffectiveAt(versions: PriceGrid[], day: string): PriceGrid {
  const applicable = versions.filter((v) => v.effectiveFrom <= day).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return applicable[0] ?? [...versions].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))[0];
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * MeteringService — service public du MeteringModule (B.8).
 *
 * SEC-37 : la grille tarifaire est PERSISTÉE et VERSIONNÉE
 * (`price_grid_version`) ; `PUT /pricing/grid` crée une nouvelle version à
 * date d'effet (aujourd'hui ou plus tard, jamais rétroactive), validée par
 * un DTO strict et scellée dans le journal. Les factures restent SIMULÉES
 * (`MOCK_MEASURED_CONSUMPTION`, collecte réelle non branchée) : marquées
 * `SIMULEE` hors production et refusées en production.
 */
@Injectable()
export class MeteringService {
  private readonly logger = new Logger('MeteringService');
  /** Repli mémoire (et référence) : TARIF-2026.01 puis les versions créées pendant la vie du process. */
  private readonly memoryVersions: PriceGrid[] = [SEED_PRICE_GRID];

  constructor(
    @Optional() @InjectRepository(PriceGridVersion) private readonly repo?: EntityRepository<PriceGridVersion>,
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  /** Grille de référence en mémoire (dernière version connue du process) — calculs dérivés non bloquants. */
  getGrid(): PriceGrid {
    return gridEffectiveAt(this.memoryVersions, todayUtc());
  }

  private async versions(): Promise<PriceGrid[]> {
    if (!this.repo) return this.memoryVersions;
    return withDegradedFallback(
      'MeteringService.versions',
      async () => {
        const rows = await this.repo!.findAll({ orderBy: { effectiveFrom: 'ASC' } });
        return [SEED_PRICE_GRID, ...rows.map((r) => ({ ...r.grid, version: r.version, effectiveFrom: r.effectiveFrom }))];
      },
      () => this.memoryVersions,
    );
  }

  /** Grille en vigueur pour une période AAAA-MM (premier jour du mois) ou, sans période, aujourd'hui. */
  async gridFor(period?: string): Promise<PriceGrid> {
    return gridEffectiveAt(await this.versions(), period ? `${period}-01` : todayUtc());
  }

  /** SEC-37 : aucune facture simulée n'est servie en production (collecte réelle non branchée). */
  assertSimulationAllowed(): void {
    if (process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException({
        code: 'FACTURATION_SIMULEE_INDISPONIBLE',
        message: 'Facturation indisponible : la collecte réelle de consommation n’est pas branchée (données simulées non servies en production).',
      });
    }
  }

  /** Mesure simulée courante d'une métrique (0 si inconnue) — `Object.hasOwn` : jamais une clé héritée (`__proto__`, `constructor`). */
  measuredFor(metric: string): number {
    return Object.hasOwn(MOCK_MEASURED_CONSUMPTION, metric) ? MOCK_MEASURED_CONSUMPTION[metric] : 0;
  }

  history(metric: string, period: string, monthsCount = 10): { period: string; value: number }[] {
    return buildMeasuredHistory(this.measuredFor(metric), period, monthsCount);
  }

  /** Lignes de facture pour UNE compagnie (même calcul que la facture mensuelle). */
  computeInvoiceLines(grid: PriceGrid = this.getGrid()): InvoiceLine[] {
    return grid.metrics.map((m) => {
      const mesure = this.measuredFor(m.metric);
      const facturable = Math.max(0, mesure - m.includedQuota);
      const divider = m.unit.startsWith('1 000') ? 1000 : m.unit.startsWith('100 ') ? 100 : 1;
      const amount = Math.round((facturable / divider) * m.unitPrice);
      return { ...m, measured: mesure, facturable, amount };
    });
  }

  /**
   * Dashboard des coûts place entière (écran 14 "Coûts & tarification") —
   * somme, pour CHAQUE adhérent réel (`adherentCount`), la MÊME facture
   * simulée que `/metering/:company/:period`.
   */
  placeSummary(adherentCount: number, grid: PriceGrid = this.getGrid()) {
    const perCompanyLines = this.computeInvoiceLines(grid);
    const subscriptionTotal = grid.subscription.monthly * adherentCount;
    const lines = perCompanyLines.map((l) => ({
      metric: l.metric,
      label: l.label,
      unit: l.unit,
      measured: l.measured * adherentCount,
      facturable: l.facturable * adherentCount,
      amountHT: l.amount * adherentCount,
    }));
    const consumptionTotal = lines.reduce((s, l) => s + l.amountHT, 0);
    const revenueTotal = subscriptionTotal + consumptionTotal;
    return {
      gridVersion: grid.version,
      adherentCount,
      subscriptionTotal,
      consumptionTotal,
      revenueTotal,
      inducerCount: grid.metrics.length,
      simulated: true,
      lines: lines.map((l) => ({ ...l, revenueSharePct: consumptionTotal > 0 ? Math.round((l.amountHT / consumptionTotal) * 1000) / 10 : 0 })),
    };
  }

  /**
   * SEC-37 — nouvelle version de la grille : libellé inédit, date d'effet
   * au plus tôt aujourd'hui (aucune modification rétroactive d'une facture),
   * construite à partir de la version en vigueur à cette date, persistée puis
   * scellée dans le journal (`GRILLE_TARIFAIRE`).
   */
  async updateGrid(patch: UpdatePriceGridDto, actor: AuthenticatedUser): Promise<PriceGrid> {
    if (patch.effectiveFrom < todayUtc()) {
      throw new BadRequestException({ code: 'DATE_EFFET_RETROACTIVE', message: 'La date d’effet d’une nouvelle grille ne peut pas être antérieure à aujourd’hui.' });
    }
    const versions = await this.versions();
    if (versions.some((v) => v.version === patch.version)) {
      throw new ConflictException({ code: 'VERSION_EXISTANTE', message: `La version ${patch.version} existe déjà : une grille publiée n’est jamais modifiée.` });
    }
    const next = mergeGrid(gridEffectiveAt(versions, patch.effectiveFrom), patch);
    const author = actor.email || actor.id;
    const repo = this.repo;
    if (repo) {
      await withDegradedFallback(
        'MeteringService.updateGrid',
        async () => {
          await repo.getEntityManager().persistAndFlush(repo.create({ version: next.version, effectiveFrom: next.effectiveFrom, grid: next, createdBy: author } as never));
        },
        () => undefined,
      );
    }
    this.memoryVersions.push(next);
    await this.ledger?.append('GRILLE_TARIFAIRE', next.version, author, `Nouvelle grille ${next.version} en vigueur au ${next.effectiveFrom} (abonnement ${next.subscription.monthly} DA, ${next.metrics.length} inducteurs).`);
    this.logger.log(`Grille ${next.version} créée par ${author}, en vigueur au ${next.effectiveFrom}.`);
    return next;
  }

  /** Prix unitaire d'une métrique de la grille courante (0 si inconnue — ne doit jamais lever pour un calcul dérivé non bloquant). */
  unitPrice(metric: string): number {
    return this.getGrid().metrics.find((m) => m.metric === metric)?.unitPrice ?? 0;
  }
}
