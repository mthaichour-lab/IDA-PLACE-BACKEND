import { Injectable } from '@nestjs/common';
import { buildWilayaSeeds, WilayaSeed } from '../adherents/wilayas.data';
import { ClaimsService } from '../claims/claims.service';
import { RecoursService } from '../recours/recours.service';

export interface WilayaStatDto extends WilayaSeed {
  declarations: number;
  montants: number;
}

export interface MonthlyStatDto {
  month: string;
  declarations: number;
  econstat: number;
  autresCanaux: number;
  /** Nombre de recours ouverts ce mois (Annexe 2 — notification initiale, B.3 RecoursModule). */
  annexes2: number;
  /** Nombre d'oppositions levées ce mois (Recours.opposition.raisedAt, Art. 12). */
  oppositions: number;
  /** Nombre de recours réglés ce mois (state REGLE, settledAt — assuré indemnisé). */
  indemnises: number;
}

export interface StatsSummaryDto {
  /** Total des déclarations (toutes périodes). */
  declarations: number;
  /** % de recours ayant fait l'objet d'une opposition (Art. 12), sur l'ensemble des recours. */
  oppositionRatePct: number;
  /** Somme des montants des recours réglés (state REGLE) — montant effectivement compensé via IDA. */
  settledAmount: number;
  /** Délai moyen (jours) entre l'ouverture du recours (requestSentAt) et son règlement (settledAt), recours REGLE uniquement. */
  avgSettlementDays: number | null;
}

/**
 * StatsModule — écran 11 "Statistiques de la place", B.2.
 *
 * Agrégation RÉELLE depuis `ClaimsModule` + `RecoursModule` (ce dernier est
 * devenu réel après réconciliation sprint 3 — les champs `annexes2`/
 * `oppositions`/`indemnises` ci-dessous, omis un temps faute de source
 * réelle, sont donc maintenant calculés, pas inventés) :
 *  - `wilayas()` : déclarations + montants réels par wilaya (référentiel
 *    des 69 wilayas déjà réel — `wilayas.data.ts`).
 *  - `monthly()` : activité mensuelle réelle — déclarations (par mois
 *    d'accident) + canal de déclaration (`Claim.canalDeclaration`) +
 *    Annexes 2 émises / oppositions / recours réglés ("indemnisés"), tous
 *    les trois dérivés de `RecoursService.listAll()` (B.4.A4 écran 11).
 *  - `summary()` : KPI de synthèse (déclarations totales, taux
 *    d'opposition, montant compensé, délai moyen de règlement) — nouveau,
 *    demandé par le guide illustré de référence (voir HANDOFF.md).
 *
 * ⚠️ Métriques volontairement OMISES plutôt qu'inventées (voir consigne de
 * la mission : « documente l'hypothèse ou omets proprement ») :
 *  - `pour100k` ("Pour 100 000 hab.") : nécessite un référentiel de
 *    population par wilaya ABSENT du dossier technique et de ce worktree.
 *    Omis entièrement (l'ancien mock inventait une valeur) — à réintroduire
 *    si un référentiel démographique officiel est fourni.
 *  - "e-constat MOBILE vs AGENCE" (demandé par la mission) : le modèle de
 *    données réel (`Claim.canalDeclaration`, B.4 colonne 47) ne distingue
 *    qu'ERP/ECONSTAT/IMPORT/API — PAS mobile vs agence au sein du canal
 *    ECONSTAT (aucun champ "device"/"kiosque" dans le dossier technique ni
 *    dans le guide illustré). `econstat`/`autresCanaux` restent une
 *    approximation honnête (canal ECONSTAT vs ERP+IMPORT+API), PAS un
 *    "mobile vs agence" — à ne jamais relabelliser comme tel côté front
 *    sans vraie donnée source.
 *  - Comparatif "vs IRSAM (74j)" (KPI du guide illustré) : nécessite une
 *    valeur de référence IRSAM externe, absente des deux documents — omis,
 *    `avgSettlementDays` (délai réel IDA) est exposé seul.
 *  - Codes de barème Art.14 (B01-B11), catégories de véhicules, tableau
 *    "Délais de bout en bout" : nécessitent des champs qui n'existent pas
 *    sur `Claim` (code barème, catégorie véhicule) — hors périmètre de
 *    cette passe, à chiffrer séparément si repris.
 */
@Injectable()
export class StatsService {
  constructor(
    private readonly claims: ClaimsService,
    private readonly recours: RecoursService,
  ) {}

  async wilayas(): Promise<WilayaStatDto[]> {
    const { items: allClaims } = await this.claims.list({ page: 1, pageSize: 100_000 });
    const byWilaya = new Map<string, { count: number; amount: number }>();
    for (const c of allClaims) {
      if (!c.wilaya) continue;
      const entry = byWilaya.get(c.wilaya) ?? { count: 0, amount: 0 };
      entry.count += 1;
      entry.amount += c.expertAmount ?? c.estimatedAmount ?? 0;
      byWilaya.set(c.wilaya, entry);
    }
    return buildWilayaSeeds().map((w) => {
      const entry = byWilaya.get(w.code);
      return { ...w, declarations: entry?.count ?? 0, montants: entry?.amount ?? 0 };
    });
  }

  async monthly(): Promise<MonthlyStatDto[]> {
    const { items: allClaims } = await this.claims.list({ page: 1, pageSize: 100_000 });
    const allRecours = await this.recours.listAll();
    type MonthEntry = { declarations: number; econstat: number; autresCanaux: number; annexes2: number; oppositions: number; indemnises: number };
    const byMonth = new Map<string, MonthEntry>();
    const blank = (): MonthEntry => ({ declarations: 0, econstat: 0, autresCanaux: 0, annexes2: 0, oppositions: 0, indemnises: 0 });

    for (const c of allClaims) {
      const dateSource = c.accidentDate || c.createdAt;
      if (!dateSource) continue;
      const month = dateSource.slice(0, 7); // YYYY-MM
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      const entry = byMonth.get(month) ?? blank();
      entry.declarations += 1;
      if (c.canalDeclaration === 'ECONSTAT') entry.econstat += 1;
      else if (c.canalDeclaration) entry.autresCanaux += 1;
      byMonth.set(month, entry);
    }

    for (const r of allRecours) {
      // Annexe 2 = notification initiale du recours (B.4.A4 écran 4) — émise à l'ouverture (requestSentAt).
      const annexeMonth = r.requestSentAt.slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(annexeMonth)) {
        const entry = byMonth.get(annexeMonth) ?? blank();
        entry.annexes2 += 1;
        byMonth.set(annexeMonth, entry);
      }
      if (r.opposition?.raisedAt) {
        const oppMonth = r.opposition.raisedAt.slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(oppMonth)) {
          const entry = byMonth.get(oppMonth) ?? blank();
          entry.oppositions += 1;
          byMonth.set(oppMonth, entry);
        }
      }
      if (r.state === 'REGLE' && r.settledAt) {
        const settledMonth = r.settledAt.slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(settledMonth)) {
          const entry = byMonth.get(settledMonth) ?? blank();
          entry.indemnises += 1;
          byMonth.set(settledMonth, entry);
        }
      }
    }

    return Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, ...v }));
  }

  async summary(): Promise<StatsSummaryDto> {
    const { total: declarations } = await this.claims.list({ page: 1, pageSize: 1 });
    const allRecours = await this.recours.listAll();

    const withOpposition = allRecours.filter((r) => !!r.opposition).length;
    const oppositionRatePct = allRecours.length === 0 ? 0 : Math.round((withOpposition / allRecours.length) * 1000) / 10;

    const settled = allRecours.filter((r) => r.state === 'REGLE' && r.settledAt);
    const settledAmount = settled.reduce((sum, r) => sum + r.amount, 0);

    let avgSettlementDays: number | null = null;
    if (settled.length > 0) {
      const totalDays = settled.reduce((sum, r) => sum + (new Date(r.settledAt!).getTime() - new Date(r.requestSentAt).getTime()) / 86_400_000, 0);
      avgSettlementDays = Math.round((totalDays / settled.length) * 10) / 10;
    }

    return { declarations, oppositionRatePct, settledAmount, avgSettlementDays };
  }
}
