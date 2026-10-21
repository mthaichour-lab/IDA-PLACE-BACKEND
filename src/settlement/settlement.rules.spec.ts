import { toCents } from '../recours/money';
import {
  canonicalJson,
  computeBilateralMatrix,
  computeBilateralNetPositions,
  computeDirectionalPairs,
  computeMultilateralNetPositions,
  isIsoDateInMonth,
  isPeriodElapsed,
  lastDayOfMonth,
  lastDayOfQuarter,
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

  it('sens : la compagnie demanderesse (from, créancière) reçoit, les compagnies mises en cause (to) paient', () => {
    const matrix = computeBilateralMatrix([
      { from: 'CAAT', to: 'SAA', amount: 100 },
      { from: 'CAAT', to: 'CASH', amount: 50 },
    ]);
    const net = computeMultilateralNetPositions(matrix);
    expect(net.find((n) => n.code === 'CAAT')?.net).toBe(150);
    expect(net.find((n) => n.code === 'SAA')?.net).toBe(-100);
    expect(net.find((n) => n.code === 'CASH')?.net).toBe(-50);
  });

  it('cas constaté le 2026-10-20 : un seul recours CAAT→SAA réglé (30 000 DA) — CAAT à recevoir dans la matrice ET en net', () => {
    const matrix = computeBilateralMatrix([{ from: 'CAAT', to: 'SAA', amount: 30_000 }]);
    expect(matrix.CAAT.SAA).toBe(30_000);
    expect(computeMultilateralNetPositions(matrix)).toEqual([
      { code: 'CAAT', net: 30_000 },
      { code: 'SAA', net: -30_000 },
    ]);
    expect(computeBilateralNetPositions(matrix)).toEqual([{ from: 'CAAT', to: 'SAA', amount: 30_000 }]);
  });

  it('cohérence des trois vues : net multilatéral = total en ligne − total en colonne = créances nettes bilatérales − dettes nettes bilatérales', () => {
    const rows = [
      { from: 'CAAT', to: 'SAA', amount: 180_000 },
      { from: 'SAA', to: 'CAAT', amount: 65_000 },
      { from: 'SAA', to: 'CASH', amount: 40_000 },
      { from: 'CASH', to: 'CAAR', amount: 12_000 },
      { from: '2A', to: 'CAAT', amount: 5_000 },
    ];
    const matrix = computeBilateralMatrix(rows);
    const bilateral = computeBilateralNetPositions(matrix);
    for (const { code, net } of computeMultilateralNetPositions(matrix)) {
      const rowTotal = rows.filter((r) => r.from === code).reduce((acc, r) => acc + r.amount, 0);
      const colTotal = rows.filter((r) => r.to === code).reduce((acc, r) => acc + r.amount, 0);
      expect(net).toBe(rowTotal - colTotal);
      const bilateralNet = bilateral.reduce((acc, p) => acc + (p.from === code ? p.amount : p.to === code ? -p.amount : 0), 0);
      expect(net).toBe(bilateralNet);
    }
  });

  it('matrice vide : aucune compagnie, aucune position', () => {
    expect(computeMultilateralNetPositions({})).toEqual([]);
  });
});

describe('SEC-34 — compensation en centimes entiers (propriétés)', () => {
  /** Générateur pseudo-aléatoire déterministe (LCG) : le test est reproductible. */
  function rng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }
  const companies = ['CAAT', 'SAA', 'CASH', 'ALLI', 'GAM', 'CAAR'];

  it('pour 200 jeux aléatoires, la somme des positions nettes multilatérales vaut EXACTEMENT 0 centime et chaque net est exact', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = rng(seed);
      const rows = Array.from({ length: 1 + Math.floor(random() * 60) }, () => {
        const from = companies[Math.floor(random() * companies.length)];
        let to = companies[Math.floor(random() * companies.length)];
        if (to === from) to = companies[(companies.indexOf(from) + 1) % companies.length];
        return { from, to, amount: Math.floor(random() * 30_000_000) / 100 }; // jusqu'à 300 000,00 DA, 2 décimales
      });
      const matrix = computeBilateralMatrix(rows);
      const net = computeMultilateralNetPositions(matrix);
      expect(net.reduce((sum, n) => sum + toCents(n.net), 0)).toBe(0);
      for (const n of net) {
        // Le créancier (from) reçoit, le débiteur (to) paie.
        const expected = rows.reduce((acc, r) => acc + (r.from === n.code ? toCents(r.amount) : 0) - (r.to === n.code ? toCents(r.amount) : 0), 0);
        expect(toCents(n.net)).toBe(expected);
        expect(Number.isInteger(Math.round(n.net * 100))).toBe(true);
      }
      // Netting bilatéral : chaque position est positive, à deux décimales.
      for (const p of computeBilateralNetPositions(matrix)) {
        expect(p.amount).toBeGreaterThan(0);
        expect(Math.abs(p.amount * 100 - Math.round(p.amount * 100))).toBeLessThan(1e-6);
      }
    }
  });

  it('aucun résidu flottant : 0,10 + 0,20 contre 0,30 donne une position nulle, pas 5,5e-17', () => {
    const matrix = computeBilateralMatrix([
      { from: 'CAAT', to: 'SAA', amount: 0.1 },
      { from: 'CAAT', to: 'SAA', amount: 0.2 },
      { from: 'SAA', to: 'CAAT', amount: 0.3 },
    ]);
    expect(matrix.CAAT.SAA).toBe(0.3);
    expect(computeBilateralNetPositions(matrix)).toEqual([]);
    expect(computeMultilateralNetPositions(matrix).map((n) => n.net)).toEqual([0, 0]);
  });

  it('les paires de l’Annexe 7 sont sommées au centime près', () => {
    const pairs = computeDirectionalPairs([
      { from: 'CAAT', to: 'SAA', amount: 0.1 },
      { from: 'CAAT', to: 'SAA', amount: 0.2 },
    ]);
    expect(pairs).toEqual([{ from: 'CAAT', to: 'SAA', count: 2, totalAmount: 0.3 }]);
  });
});

describe('SEC-19 — périodes échues et instantané canonique', () => {
  it('une période n’est échue qu’après son dernier jour', () => {
    expect(lastDayOfMonth({ year: 2026, month: 2 })).toBe('2026-02-28');
    expect(lastDayOfQuarter({ year: 2026, quarter: 4 })).toBe('2026-12-31');
    expect(isPeriodElapsed('2026-03-31', new Date('2026-03-31T23:59:00Z'))).toBe(false);
    expect(isPeriodElapsed('2026-03-31', new Date('2026-04-01T00:00:00Z'))).toBe(true);
  });

  it('la sérialisation canonique ne dépend pas de l’ordre des clés', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
