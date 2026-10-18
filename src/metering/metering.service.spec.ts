import { buildMeasuredHistory } from './metering.service';

describe('buildMeasuredHistory (fonction pure — écran 10, historique mensuel MOCK)', () => {
  it('renvoie `monthsCount` points, chronologiques, se terminant sur le mois demandé', () => {
    const points = buildMeasuredHistory(1000, '2026-10', 10);
    expect(points).toHaveLength(10);
    expect(points[0].period).toBe('2026-01');
    expect(points[points.length - 1].period).toBe('2026-10');
  });

  it('le dernier mois (courant, partiel) vaut 45% de la valeur mesurée', () => {
    const points = buildMeasuredHistory(1000, '2026-10', 10);
    expect(points[points.length - 1].value).toBe(450);
  });

  it('rampe croissante (monotone) jusqu’au mois courant', () => {
    const points = buildMeasuredHistory(1000, '2026-10', 10);
    for (let i = 1; i < points.length - 1; i++) {
      expect(points[i].value).toBeGreaterThanOrEqual(points[i - 1].value);
    }
  });

  it('déterministe : deux appels identiques renvoient exactement les mêmes valeurs', () => {
    expect(buildMeasuredHistory(730, '2026-09', 10)).toEqual(buildMeasuredHistory(730, '2026-09', 10));
  });

  it('gère le passage d’année (ex: se terminant en janvier)', () => {
    const points = buildMeasuredHistory(500, '2026-01', 10);
    expect(points[0].period).toBe('2025-04');
    expect(points[points.length - 1].period).toBe('2026-01');
  });
});
