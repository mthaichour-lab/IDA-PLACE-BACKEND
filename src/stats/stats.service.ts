import { Injectable } from '@nestjs/common';
import { buildWilayaSeeds, WilayaSeed } from '../adherents/wilayas.data';
import { ClaimsService } from '../claims/claims.service';

export interface WilayaStatDto extends WilayaSeed {
  declarations: number;
  montants: number;
}

export interface MonthlyStatDto {
  month: string;
  declarations: number;
  econstat: number;
  autresCanaux: number;
}

/**
 * StatsModule — écran 11 "Statistiques de la place", B.2.
 *
 * Agrégation RÉELLE depuis `ClaimsModule` (plus de mesures aléatoires
 * déterministes) :
 *  - `wilayas()` : déclarations + montants réels par wilaya (référentiel
 *    des 69 wilayas déjà réel — `wilayas.data.ts`).
 *  - `monthly()` : activité mensuelle réelle (déclarations, par mois
 *    d'accident) + répartition par canal de déclaration (`Claim.
 *    canalDeclaration`, seul champ réel disponible pour approcher
 *    l'adoption e-constat — voir notes ci-dessous).
 *
 * ⚠️ Métriques volontairement OMISES plutôt qu'inventées (voir consigne de
 * la mission : « documente l'hypothèse ou omets proprement ») :
 *  - `pour100k` ("Pour 100 000 hab.") : nécessite un référentiel de
 *    population par wilaya ABSENT du dossier technique et de ce worktree.
 *    Omis entièrement (l'ancien mock inventait une valeur) — à réintroduire
 *    si un référentiel démographique officiel est fourni.
 *  - `annexes2`/`oppositions`/`indemnises` (activité mensuelle) :
 *    dépendent de RecoursModule/SettlementModule, toujours des mocks dans ce
 *    worktree (hors périmètre de ce sprint) — omis plutôt qu'inventés.
 *  - "e-constat MOBILE vs AGENCE" (demandé par la mission) : le modèle de
 *    données réel (`Claim.canalDeclaration`, B.4 colonne 47) ne distingue
 *    qu'ERP/ECONSTAT/IMPORT/API — PAS mobile vs agence au sein du canal
 *    ECONSTAT (aucun champ "device"/"kiosque" dans le dossier technique).
 *    Approximation documentée : `econstat` = canal ECONSTAT, `autresCanaux`
 *    = ERP+IMPORT+API. ⚠️ Changement de forme par rapport à l'ancien mock
 *    (`econstatMobile`/`econstatAgence`) — à signaler au Frontend/PO (voir
 *    rapport de fin de sprint), StatsModule n'étant pas dans la liste des
 *    contrats figés (ClaimsModule/MatchingModule/CockpitModule/...).
 * // TODO sprint suivant : si Annexes 2 (RecoursModule) devient réel,
 * // réintroduire `annexes2`/`oppositions`/`indemnises` à partir de données
 * // réelles.
 */
@Injectable()
export class StatsService {
  constructor(private readonly claims: ClaimsService) {}

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
    const byMonth = new Map<string, { declarations: number; econstat: number; autresCanaux: number }>();

    for (const c of allClaims) {
      const dateSource = c.accidentDate || c.createdAt;
      if (!dateSource) continue;
      const month = dateSource.slice(0, 7); // YYYY-MM
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      const entry = byMonth.get(month) ?? { declarations: 0, econstat: 0, autresCanaux: 0 };
      entry.declarations += 1;
      if (c.canalDeclaration === 'ECONSTAT') entry.econstat += 1;
      else if (c.canalDeclaration) entry.autresCanaux += 1;
      byMonth.set(month, entry);
    }

    return Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, declarations: v.declarations, econstat: v.econstat, autresCanaux: v.autresCanaux }));
  }
}
