import { ALGERIA_FIXED_HOLIDAYS, ALGERIA_WEEKEND_DAYS } from '../adherents/referential-reference-data';
import { isBusinessDay, nthBusinessDayOfMonth, WorkingCalendar } from './business-days';

const DZ: WorkingCalendar = { weekendDays: ALGERIA_WEEKEND_DAYS, fixedHolidays: ALGERIA_FIXED_HOLIDAYS };
const NO_HOLIDAYS: WorkingCalendar = { weekendDays: ALGERIA_WEEKEND_DAYS, fixedHolidays: [] };

describe('Jours ouvrés (week-end vendredi-samedi + fériés)', () => {
  it('le vendredi et le samedi ne sont pas ouvrés, le dimanche l’est', () => {
    expect(isBusinessDay('2026-10-02', DZ)).toBe(false); // vendredi
    expect(isBusinessDay('2026-10-03', DZ)).toBe(false); // samedi
    expect(isBusinessDay('2026-10-04', DZ)).toBe(true); // dimanche
  });

  it('un férié fixe tombant en semaine n’est pas ouvré (1er novembre 2026, un dimanche)', () => {
    expect(isBusinessDay('2026-11-01', DZ)).toBe(false);
    expect(isBusinessDay('2026-11-01', NO_HOLIDAYS)).toBe(true);
  });

  it('un férié fixe se répète au-delà des années listées (1er novembre 2028, un mercredi)', () => {
    expect(isBusinessDay('2028-11-01', DZ)).toBe(false);
    expect(isBusinessDay('2028-11-02', DZ)).toBe(true);
  });

  it('un férié supplémentaire (ex. fête hégirienne saisie) n’est pas ouvré', () => {
    expect(isBusinessDay('2026-11-02', DZ)).toBe(true);
    expect(isBusinessDay('2026-11-02', DZ, ['2026-11-02'])).toBe(false);
  });

  it('5e jour ouvré : sans férié, avec un férié fixe, puis avec un férié supplémentaire', () => {
    expect(nthBusinessDayOfMonth(2026, 11, 5, NO_HOLIDAYS)).toBe('2026-11-05');
    expect(nthBusinessDayOfMonth(2026, 11, 5, DZ)).toBe('2026-11-08');
    expect(nthBusinessDayOfMonth(2026, 11, 5, DZ, ['2026-11-02'])).toBe('2026-11-09');
  });

  it('5e jour ouvré d’octobre 2026 saute le premier week-end', () => {
    expect(nthBusinessDayOfMonth(2026, 10, 5, DZ)).toBe('2026-10-07');
  });

  it('rejette un rang invalide', () => {
    expect(() => nthBusinessDayOfMonth(2026, 10, 0, DZ)).toThrow();
    expect(() => nthBusinessDayOfMonth(2026, 10, 40, DZ)).toThrow();
  });
});
