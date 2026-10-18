/**
 * Règles métier du SettlementModule — B.2/B.3, écrans 5 "Cycle mensuel" et 6
 * "Compensation trimestrielle". Fonctions PURES (aucune I/O), testées sans
 * Nest ni base de données (même esprit que `recours.rules.ts`/
 * `matching.scoring.ts`).
 */

export interface PeriodMonth {
  year: number;
  /** 1-12. */
  month: number;
}

export interface PeriodQuarter {
  year: number;
  /** 1-4. */
  quarter: number;
}

const MONTH_PERIOD_RE = /^(\d{4})-(\d{2})$/;
const QUARTER_PERIOD_RE = /^(\d{4})-Q([1-4])$/;

/** Parse "AAAA-MM" (ex: "2026-01"). Lève une `Error` simple (traduite en 400 par le service) si le format est invalide. */
export function parsePeriodMonth(period: string): PeriodMonth {
  const m = MONTH_PERIOD_RE.exec(period);
  if (!m) throw new Error(`Format de période mensuelle invalide: "${period}" (attendu AAAA-MM)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Mois invalide dans la période "${period}" (attendu 01-12)`);
  return { year, month };
}

/** Parse "AAAA-Qn" (ex: "2026-Q1"). */
export function parsePeriodQuarter(q: string): PeriodQuarter {
  const m = QUARTER_PERIOD_RE.exec(q);
  if (!m) throw new Error(`Format de trimestre invalide: "${q}" (attendu AAAA-Qn, n=1-4)`);
  return { year: Number(m[1]), quarter: Number(m[2]) };
}

export function isIsoDateInMonth(iso: string, period: PeriodMonth): boolean {
  const d = new Date(iso);
  return d.getUTCFullYear() === period.year && d.getUTCMonth() + 1 === period.month;
}

export function isIsoDateInQuarter(iso: string, period: PeriodQuarter): boolean {
  const d = new Date(iso);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return d.getUTCFullYear() === period.year && q === period.quarter;
}

export interface SettledRecoursLike {
  from: string;
  to: string;
  amount: number;
}

/** Matrice brute des positions bilatérales : matrix[a][b] = total que `a` doit à `b`. */
export type BilateralMatrix = Record<string, Record<string, number>>;

export function computeBilateralMatrix(rows: SettledRecoursLike[]): BilateralMatrix {
  const matrix: BilateralMatrix = {};
  for (const r of rows) {
    if (!matrix[r.from]) matrix[r.from] = {};
    matrix[r.from][r.to] = (matrix[r.from][r.to] ?? 0) + r.amount;
  }
  return matrix;
}

function allCompanies(matrix: BilateralMatrix): string[] {
  const companies = new Set<string>();
  for (const a of Object.keys(matrix)) {
    companies.add(a);
    for (const b of Object.keys(matrix[a])) companies.add(b);
  }
  return Array.from(companies).sort();
}

export interface BilateralNetPosition {
  from: string;
  to: string;
  amount: number;
}

/**
 * Netting BILATÉRAL : réduit chaque paire {A,B} à une seule direction nette
 * (le plus gros montant brut moins le plus petit). Une paire parfaitement
 * compensée (mêmes montants dans les deux sens) disparaît (amount === 0,
 * exclue du résultat). Ne compense PAS les cycles à 3 compagnies ou plus
 * (voir `computeMultilateralNetPositions` pour la compensation de place).
 */
export function computeBilateralNetPositions(matrix: BilateralMatrix): BilateralNetPosition[] {
  const companies = allCompanies(matrix);
  const result: BilateralNetPosition[] = [];
  const seen = new Set<string>();
  for (const a of companies) {
    for (const b of companies) {
      if (a === b) continue;
      const key = [a, b].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const ab = matrix[a]?.[b] ?? 0;
      const ba = matrix[b]?.[a] ?? 0;
      const net = ab - ba;
      if (net > 0) result.push({ from: a, to: b, amount: net });
      else if (net < 0) result.push({ from: b, to: a, amount: -net });
      // net === 0 : position bilatérale intégralement compensée, aucune ligne.
    }
  }
  return result;
}

export interface CompanyNetPosition {
  code: string;
  /** Positif = la compagnie doit recevoir (créditrice nette de la place) ; négatif = elle doit payer. */
  net: number;
}

/**
 * Compensation MULTILATÉRALE (écran 6) : chaque compagnie règle/reçoit UNE
 * seule position nette vis-à-vis de la "place" (chambre de compensation),
 * plutôt que de régler chaque contrepartie bilatéralement. C'est l'intérêt
 * principal de la compensation multilatérale par rapport au netting
 * bilatéral : elle annule aussi les cycles (A doit à B, B doit à C, C doit à
 * A), pas seulement les paires symétriques — voir le cas de test du cycle à
 * 3 compagnies. Invariant garanti : la somme des positions nettes est
 * toujours 0 (la place ne gagne et ne perd jamais d'argent elle-même).
 */
export function computeMultilateralNetPositions(matrix: BilateralMatrix): CompanyNetPosition[] {
  const companies = allCompanies(matrix);
  return companies.map((code) => {
    let incoming = 0;
    let outgoing = 0;
    for (const other of companies) {
      if (other === code) continue;
      incoming += matrix[other]?.[code] ?? 0;
      outgoing += matrix[code]?.[other] ?? 0;
    }
    return { code, net: incoming - outgoing };
  });
}

export interface DirectionalPair {
  from: string;
  to: string;
  count: number;
  totalAmount: number;
}

/**
 * Regroupe des recours par paire orientée (from, to) EXACTE, SANS aucun
 * netting — à la différence de `computeBilateralMatrix`/
 * `computeBilateralNetPositions` (compensation trimestrielle). Pour
 * l'Annexe 7 du cycle mensuel (écran 5, guide illustré) : une ligne
 * CAAT→SAA et une ligne SAA→CAAT restent deux lignes distinctes si les deux
 * existent, chacune avec son propre nombre de recours et son montant total.
 */
export function computeDirectionalPairs(rows: SettledRecoursLike[]): DirectionalPair[] {
  const map = new Map<string, DirectionalPair>();
  for (const r of rows) {
    const key = `${r.from}\u0000${r.to}`;
    const bucket = map.get(key) ?? { from: r.from, to: r.to, count: 0, totalAmount: 0 };
    bucket.count += 1;
    bucket.totalAmount += r.amount;
    map.set(key, bucket);
  }
  return Array.from(map.values());
}

/**
 * Échéance de saisie des recours réglés du cycle mensuel (écran 5, guide
 * illustré) : le 5e jour du mois suivant `period`, en ISO simple
 * (AAAA-MM-05).
 *
 * ⚠️ HYPOTHÈSE SIMPLIFICATRICE documentée (voir `settlement.service.ts`) :
 * jours CALENDAIRES, pas ouvrés — la capture de référence affiche "5e jour
 * ouvré", mais aucun calendrier de jours fériés algériens n'existe dans ce
 * dépôt ; en inventer un serait plus risqué que de documenter cet écart.
 */
export function computeInsertionDeadline(period: PeriodMonth): string {
  const nextMonth = period.month === 12 ? 1 : period.month + 1;
  const nextYear = period.month === 12 ? period.year + 1 : period.year;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-05`;
}
