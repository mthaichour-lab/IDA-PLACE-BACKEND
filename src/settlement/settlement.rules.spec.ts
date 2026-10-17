import {
  computeBilateralMatrix,
  computeBilateralNetPositions,
  computeMultilateralNetPositions,
  isIsoDateInMonth,
  isIsoDateInQuarter,
  parsePeriodMonth,
  parsePeriodQuarter,
} from './settlement.rules';

describe('parsePeriodMonth', () => {
  it('parse "2026-01" correctement', () => {
    expect(parsePeriodMonth('2026-01')).toEqual({ year: 2026, month: 1 });
  });

  it('accepte les cas limites 01 et 12', () => {
    expect(parsePeriodMonth('2026-12').month).toBe(12);
    expect(parsePeriodMonth('2026-01').month).toBe(1);
  });

  it('rejette un format invalide', () => {
    expect(() => parsePeriodMonth('2026/01')).toThrow();
    expect(() => parsePeriodMonth('2026-1')).toThrow();
  });

  it('rejette un mois hors bornes (00 ou 13)', () => {
    expect(() => parsePeriodMonth('2026-00')).toThrow();
    expect(() => parsePeriodMonth('2026-13')).toThrow();
  });
});

describe('parsePeriodQuarter', () => {
  it('parse "2026-Q1" à "2026-Q4"', () => {
    expect(parsePeriodQuarter('2026-Q1')).toEqual({ year: 2026, quarter: 1 });
    expect(parsePeriodQuarter('2026-Q4')).toEqual({ year: 2026, quarter: 4 });
  });

  it('rejette un trimestre invalide (Q5)', () => {
    expect(() => parsePeriodQuarter('2026-Q5')).toThrow();
  });

  it('rejette un format invalide', () => {
    expect(() => parsePeriodQuarter('2026-1')).toThrow();
  });
});

describe('isIsoDateInMonth / isIsoDateInQuarter', () => {
  it('reconnaît une date dans le mois (cas limites : 1er et dernier jour)', () => {
    expect(isIsoDateInMonth('2026-01-01T00:00:00.000Z', { year: 2026, month: 1 })).toBe(true);
    expect(isIsoDateInMonth('2026-01-31T23:59:59.999Z', { year: 2026, month: 1 })).toBe(true);
    expect(isIsoDateInMonth('2026-02-01T00:00:00.000Z', { year: 2026, month: 1 })).toBe(false);
  });

  it('reconnaît une date dans le trimestre (Q1 = janvier-mars)', () => {
    expect(isIsoDateInQuarter('2026-01-15T00:00:00.000Z', { year: 2026, quarter: 1 })).toBe(true);
    expect(isIsoDateInQuarter('2026-03-31T23:59:59.999Z', { year: 2026, quarter: 1 })).toBe(true);
    expect(isIsoDateInQuarter('2026-04-01T00:00:00.000Z', { year: 2026, quarter: 1 })).toBe(false);
  });

  it('Q4 = octobre-décembre', () => {
    expect(isIsoDateInQuarter('2026-10-01T00:00:00.000Z', { year: 2026, quarter: 4 })).toBe(true);
    expect(isIsoDateInQuarter('2026-12-31T00:00:00.000Z', { year: 2026, quarter: 4 })).toBe(true);
    expect(isIsoDateInQuarter('2027-01-01T00:00:00.000Z', { year: 2026, quarter: 4 })).toBe(false);
  });
});

describe('computeBilateralMatrix', () => {
  it('cumule plusieurs recours entre la même paire', () => {
    const matrix = computeBilateralMatrix([
      { from: 'CAAT', to: 'SAA', amount: 100 },
      { from: 'CAAT', to: 'SAA', amount: 50 },
    ]);
    expect(matrix.CAAT.SAA).toBe(150);
  });
});

describe('computeBilateralNetPositions — netting bilatéral (cas limites)', () => {
  it('deux compagnies, une seule direction : position inchangée', () => {
    const matrix = computeBilateralMatrix([{ from: 'CAAT', to: 'SAA', amount: 100 }]);
    const positions = computeBilateralNetPositions(matrix);
    expect(positions).toEqual([{ from: 'CAAT', to: 'SAA', amount: 100 }]);
  });

  it('montants symétriques égaux : compensation totale, aucune position (cas limite)', () => {
    const matrix = computeBilateralMatrix([
      { from: 'CAAT', to: 'SAA', amount: 100 },
      { from: 'SAA', to: 'CAAT', amount: 100 },
    ]);
    expect(computeBilateralNetPositions(matrix)).toEqual([]);
  });

  it('montants asymétriques : ne garde que le sens et le solde net', () => {
    const matrix = computeBilateralMatrix([
      { from: 'CAAT', to: 'SAA', amount: 100 },
      { from: 'SAA', to: 'CAAT', amount: 40 },
    ]);
    expect(computeBilateralNetPositions(matrix)).toEqual([{ from: 'CAAT', to: 'SAA', amount: 60 }]);
  });

  it('ne compense PAS un cycle à 3 compagnies (limite du netting bilatéral)', () => {
    const matrix = computeBilateralMatrix([
      { from: 'CAAT', to: 'SAA', amount: 100 },
      { from: 'SAA', to: 'CASH', amount: 100 },
      { from: 'CASH', to: 'CAAT', amount: 100 },
    ]);
    const positions = computeBilateralNetPositions(matrix).sort((a, b) => a.from.localeCompare(b.from));
    expect(positions).toHaveLength(3);
    expect(positions.reduce((s, p) => s + p.amount, 0)).toBe(300); // aucune compensation bilatérale possible sur un cycle
  });
});

describe('computeMultilateralNetPositions — compensation multilatérale (B.2/B.3 écran 6)', () => {
  it('la somme des positions nettes est toujours 0 (la place ne gagne/perd jamais)', () => {
    const matrix = computeBilateralMatrix([
      { from: 'CAAT', to: 'SAA', amount: 180_000 },
      { from: 'SAA', to: 'CAAT', amount: 65_000 },
      { from: 'SAA', to: 'CASH', amount: 40_000 },
      { from: 'CASH', to: 'ALLI', amount: 12_000 },
      { from: 'ALLI', to: 'CAAT', amount: 5_000 },
    ]);
    const net = computeMultilateralNetPositions(matrix);
    const sum = net.reduce((s, n) => s + n.net, 0);
    expect(Math.round(sum)).toBe(0);
  });

  it('annule entièrement un cycle à 3 compagnies de montants égaux (contrairement au bilatéral)', () => {
    const matrix = computeBilateralMatrix([
      { from: 'CAAT', to: 'SAA', amount: 100 },
      { from: 'SAA', to: 'CASH', amount: 100 },
      { from: 'CASH', to: 'CAAT', amount: 100 },
    ]);
    const net = computeMultilateralNetPositions(matrix);
    for (const n of net) expect(n.net).toBe(0);
  });

  it('deux compagnies, montants symétriques égaux : positions nettes nulles de part et d’autre', () => {
    const matrix = computeBilateralMatrix([
      { from: 'CAAT', to: 'SAA', amount: 100 },
      { from: 'SAA', to: 'CAAT', amount: 100 },
    ]);
    const net = computeMultilateralNetPositions(matrix);
    expect(net.find((n) => n.code === 'CAAT')?.net).toBe(0);
    expect(net.find((n) => n.code === 'SAA')?.net).toBe(0);
  });

  it('une compagnie pure débitrice (ne reçoit jamais) a une position nette strictement négative', () => {
    const matrix = computeBilateralMatrix([
      { from: 'CAAT', to: 'SAA', amount: 100 },
      { from: 'CAAT', to: 'CASH', amount: 50 },
    ]);
    const net = computeMultilateralNetPositions(matrix);
    expect(net.find((n) => n.code === 'CAAT')?.net).toBe(-150);
    expect(net.find((n) => n.code === 'SAA')?.net).toBe(100);
    expect(net.find((n) => n.code === 'CASH')?.net).toBe(50);
  });

  it('matrice vide : aucune compagnie, aucune position', () => {
    expect(computeMultilateralNetPositions({})).toEqual([]);
  });
});
