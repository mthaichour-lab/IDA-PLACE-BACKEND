import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdatePriceGridDto } from './dto/metering.dto';
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

describe('SEC-37 — grille tarifaire validée, versionnée, non rétroactive', () => {
  const admin = { id: 'u-admin', name: 'Admin', email: 'admin@uar.dz', role: 'ADMIN_UAR', privileges: ['grid'] } as never;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const errorsOf = (body: unknown) => validateSync(plainToInstance(UpdatePriceGridDto, body));

  it.each([
    [{ metrics: [{ metric: 'apiCalls', unitPrice: -1 }] }],
    [{ metrics: [{ metric: 'apiCalls', unitPrice: 'gratuit' }] }],
    [{ metrics: [{ metric: 'apiCalls', unitPrice: 1.234 }] }],
    [{ metrics: [{ metric: '__proto__', unitPrice: 1 }] }],
    [{ subscription: { monthly: -5 } }],
    [{ version: 'v2' }],
    [{ effectiveFrom: 'demain' }],
  ])('DTO : %j refusé', (override) => {
    expect(errorsOf({ version: 'TARIF-2027.01', effectiveFrom: tomorrow, ...override })).not.toHaveLength(0);
  });

  it('DTO : correctif valide accepté', () => {
    expect(errorsOf({ version: 'TARIF-2027.01', effectiveFrom: tomorrow, metrics: [{ metric: 'sms', unitPrice: 4.75 }] })).toHaveLength(0);
  });

  it('une nouvelle version s’applique à partir de sa date d’effet, sans toucher les périodes passées, et est scellée au journal', async () => {
    const append = jest.fn(async () => ({}));
    const service = new MeteringService(undefined, { append } as never);
    const v = await service.updateGrid({ version: 'TARIF-2099.01', effectiveFrom: '2099-01-01', metrics: [{ metric: 'sms', unitPrice: 9 }] } as never, admin);
    expect(v.metrics.find((m) => m.metric === 'sms')?.unitPrice).toBe(9);
    expect((await service.gridFor('2026-10')).version).toBe('TARIF-2026.01');
    expect((await service.gridFor('2099-02')).version).toBe('TARIF-2099.01');
    expect(append).toHaveBeenCalledWith('GRILLE_TARIFAIRE', 'TARIF-2099.01', 'admin@uar.dz', expect.stringContaining('2099-01-01'));
  });

  it('date d’effet passée refusée (400), version existante refusée (409)', async () => {
    const service = new MeteringService();
    await expect(service.updateGrid({ version: 'TARIF-2099.02', effectiveFrom: '2020-01-01' } as never, admin)).rejects.toMatchObject({ status: 400 });
    await expect(service.updateGrid({ version: 'TARIF-2026.01', effectiveFrom: tomorrow } as never, admin)).rejects.toMatchObject({ status: 409 });
  });

  it('mesure : jamais une clé héritée (`__proto__`, `constructor`)', () => {
    const service = new MeteringService();
    expect(service.measuredFor('__proto__')).toBe(0);
    expect(service.measuredFor('constructor')).toBe(0);
    expect(service.measuredFor('sms')).toBeGreaterThan(0);
  });

  it('aucune facture simulée servie en production (503)', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new MeteringService().assertSimulationAllowed()).toThrow(expect.objectContaining({ status: 503 }));
    } finally {
      process.env.NODE_ENV = saved;
    }
    expect(() => new MeteringService().assertSimulationAllowed()).not.toThrow();
  });
});
