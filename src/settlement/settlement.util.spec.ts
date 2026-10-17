import { isWithinRange, parseMonthPeriod, parseQuarterPeriod } from './settlement.util';

describe('parseMonthPeriod (B.2, écran 5)', () => {
  it('résout un mois de 31 jours', () => {
    expect(parseMonthPeriod('2026-01')).toEqual({ start: '2026-01-01', end: '2026-01-31' });
  });

  it('résout février sur une année non bissextile', () => {
    expect(parseMonthPeriod('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('résout février sur une année bissextile', () => {
    expect(parseMonthPeriod('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });

  it('rejette un format invalide', () => {
    expect(() => parseMonthPeriod('2026-1')).toThrow();
    expect(() => parseMonthPeriod('2026')).toThrow();
  });
});

describe('parseQuarterPeriod (B.2, écran 6)', () => {
  it('résout le premier trimestre', () => {
    expect(parseQuarterPeriod('2026-Q1')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
  });

  it('résout le dernier trimestre', () => {
    expect(parseQuarterPeriod('2026-Q4')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
  });

  it('rejette un format invalide', () => {
    expect(() => parseQuarterPeriod('2026-Q5')).toThrow();
    expect(() => parseQuarterPeriod('2026-T1')).toThrow();
  });
});

describe('isWithinRange', () => {
  const range = { start: '2026-01-01', end: '2026-01-31' };
  it('inclut les bornes', () => {
    expect(isWithinRange('2026-01-01', range)).toBe(true);
    expect(isWithinRange('2026-01-31', range)).toBe(true);
  });
  it('exclut hors bornes', () => {
    expect(isWithinRange('2025-12-31', range)).toBe(false);
    expect(isWithinRange('2026-02-01', range)).toBe(false);
  });
  it('exclut une date absente', () => {
    expect(isWithinRange(undefined, range)).toBe(false);
    expect(isWithinRange('', range)).toBe(false);
  });
});
