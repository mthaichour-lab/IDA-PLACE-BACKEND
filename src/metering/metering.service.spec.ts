import { buildMeasuredHistory, MeteringService } from './metering.service';

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

describe('MeteringService.placeSummary (écran 14, dashboard place entière)', () => {
  const service = new MeteringService();

  it('additionne la facture mock de CHAQUE adhérent réel (jamais un nombre inventé)', () => {
    const forOne = service.placeSummary(1);
    const forFive = service.placeSummary(5);
    expect(forFive.subscriptionTotal).toBe(forOne.subscriptionTotal * 5);
    expect(forFive.consumptionTotal).toBe(forOne.consumptionTotal * 5);
    expect(forFive.revenueTotal).toBe(forFive.subscriptionTotal + forFive.consumptionTotal);
    expect(forFive.adherentCount).toBe(5);
  });

  it('inducerCount = nombre réel de métriques de la grille (pas un chiffre arbitraire)', () => {
    const summary = service.placeSummary(5);
    expect(summary.inducerCount).toBe(service.getGrid().metrics.length);
    expect(summary.lines).toHaveLength(summary.inducerCount);
  });

  it('les parts de revenu (%) somment à ~100% sur la consommation hors forfait', () => {
    const summary = service.placeSummary(3);
    const total = summary.lines.reduce((s, l) => s + l.revenueSharePct, 0);
    expect(total).toBeCloseTo(100, 0);
  });
});
