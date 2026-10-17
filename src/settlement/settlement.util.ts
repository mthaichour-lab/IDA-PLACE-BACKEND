/**
 * Fonctions PURES de résolution de période — SettlementModule, B.2 (écrans
 * 5 "Cycle mensuel" et 6 "Compensation trimestrielle"). Aucune I/O, aucune
 * dépendance Nest — testables isolément (`settlement.util.spec.ts`), sur le
 * même principe que `eligibility.rules.ts`/`matching.scoring.ts`.
 */

export interface DateRange {
  /** Inclus, format ISO `YYYY-MM-DD`. */
  start: string;
  /** Inclus, format ISO `YYYY-MM-DD`. */
  end: string;
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const QUARTER_RE = /^(\d{4})-Q([1-4])$/;

/** Parse une période mensuelle `YYYY-MM` (ex: "2026-01") en intervalle de dates inclus. */
export function parseMonthPeriod(period: string): DateRange {
  const m = MONTH_RE.exec(period);
  if (!m) throw new Error(`Période mensuelle invalide (attendu YYYY-MM) : "${period}"`);
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  if (month < 1 || month > 12) throw new Error(`Mois invalide dans "${period}"`);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0)); // dernier jour du mois
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** Parse une période trimestrielle `YYYY-Qn` (ex: "2026-Q1") en intervalle de dates inclus. */
export function parseQuarterPeriod(period: string): DateRange {
  const m = QUARTER_RE.exec(period);
  if (!m) throw new Error(`Période trimestrielle invalide (attendu YYYY-Qn) : "${period}"`);
  const year = Number(m[1]);
  const quarter = Number(m[2]); // 1-4
  const startMonth = (quarter - 1) * 3; // 0-indexed
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** `true` si `isoDate` (YYYY-MM-DD) est inclus dans `range` (bornes incluses). */
export function isWithinRange(isoDate: string | undefined, range: DateRange): boolean {
  if (!isoDate) return false;
  const d = isoDate.slice(0, 10);
  return d >= range.start && d <= range.end;
}
