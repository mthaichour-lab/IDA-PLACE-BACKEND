/**
 * Jours ouvrés — fonctions PURES (aucune I/O). Le calendrier (week-end,
 * fériés fixes) vient de `AdherentsService.getCalendar()` ; les fériés
 * supplémentaires (ex. fêtes hégiriennes saisies manuellement) sont passés
 * séparément, en dates ISO exactes.
 */

export interface WorkingCalendar {
  /** Noms anglais en majuscules ('FRIDAY', 'SATURDAY'…), cf. `ALGERIA_WEEKEND_DAYS`. */
  weekendDays: readonly string[];
  fixedHolidays: readonly { date: string }[];
}

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isBusinessDay(isoDate: string, calendar: WorkingCalendar, extraHolidays: readonly string[] = []): boolean {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (calendar.weekendDays.includes(DAY_NAMES[d.getUTCDay()])) return false;
  // Les fériés « à date fixe » se répètent chaque année : on compare le
  // MM-JJ, la liste de référence n'étant renseignée que pour quelques années.
  const monthDay = isoDate.slice(5, 10);
  if (calendar.fixedHolidays.some((h) => h.date.slice(5, 10) === monthDay)) return false;
  return !extraHolidays.includes(isoDate);
}

/** n-ième jour ouvré (n ≥ 1) du mois `month` (1-12) de `year`, en ISO AAAA-MM-JJ. */
export function nthBusinessDayOfMonth(year: number, month: number, n: number, calendar: WorkingCalendar, extraHolidays: readonly string[] = []): string {
  if (n < 1) throw new Error(`Rang de jour ouvré invalide : ${n}`);
  let count = 0;
  for (let day = 1; ; day++) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1) throw new Error(`Moins de ${n} jours ouvrés en ${year}-${String(month).padStart(2, '0')}`);
    const iso = toIso(d);
    if (isBusinessDay(iso, calendar, extraHolidays) && ++count === n) return iso;
  }
}
