import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { Recours } from '../recours/entities/recours.entity';
import { RecoursService } from '../recours/recours.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import { SettlementClosure } from './entities/settlement-closure.entity';
import { SettlementService } from './settlement.service';

/** Acteur "place" — voir recours.service.spec.ts. */
function fakeUser(name: string): AuthenticatedUser {
  return { id: name, name, email: `${name}@test.local`, role: 'OPERATEUR_PLACE', privileges: [] };
}

/** Acteur scopé compagnie (TRESORIER) — voir claims.service.spec.ts `correspondant()`. */
function fakeTresorier(companyId: string): AuthenticatedUser {
  return { id: 't', name: `tresorier.${companyId.toLowerCase()}`, email: 't@test.local', role: 'TRESORIER', companyId, privileges: ['synth'] };
}

/** Repli mémoire forcé — voir recours.service.spec.ts / claims.service.spec.ts. */
function throwingRepo() {
  return {
    create: jest.fn((data: unknown) => data),
    find: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    findOne: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    findAll: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    getEntityManager: jest.fn(() => ({
      persist: jest.fn(),
      persistAndFlush: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
      flush: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    })),
  };
}

function fakeConfigService() {
  return { get: () => undefined } as unknown as ConfigService;
}

describe('SettlementService (mode dégradé — synthèse mensuelle, compensation trimestrielle)', () => {
  let settlement: SettlementService;
  let recours: RecoursService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        SettlementService,
        RecoursService,
        { provide: getRepositoryToken(SettlementClosure), useFactory: throwingRepo },
        { provide: getRepositoryToken(Recours), useFactory: throwingRepo },
        { provide: ConfigService, useFactory: fakeConfigService },
        { provide: RealtimeGateway, useValue: { emitEvent: jest.fn() } },
      ],
    }).compile();

    settlement = moduleRef.get(SettlementService);
    recours = moduleRef.get(RecoursService);
  });

  it('monthly() rejette un format de période invalide avec un 400 normalisé', async () => {
    await expect(settlement.monthly('2026/01')).rejects.toMatchObject({ response: { code: 'BAD_REQUEST' } });
  });

  it('quarter() rejette un format de trimestre invalide avec un 400 normalisé', async () => {
    await expect(settlement.quarter('2026-Q9')).rejects.toMatchObject({ response: { code: 'BAD_REQUEST' } });
  });

  it('monthly() regroupe les recours par compagnie demanderesse', async () => {
    // Deux recours CAAT (un réglé, un en attente) sur le même mois (envoi == règlement ici).
    const inJan1 = await recours.create({ claimId: 'clm-1', from: 'CAAT', to: 'SAA', amount: 50_000 });
    await recours.create({ claimId: 'clm-2', from: 'CAAT', to: 'SAA', amount: 30_000 });
    await recours.transition(inJan1.id, { action: 'accepter' }, fakeUser('x'));

    const result = await settlement.monthly(new Date(inJan1.requestSentAt).toISOString().slice(0, 7));
    const caat = result.companies.find((c) => c.code === 'CAAT');
    expect(caat?.claimsCount).toBe(2);
    expect(caat?.resolvedCount).toBe(1);
    expect(caat?.totalAmount).toBe(80_000);
    expect(caat?.status).toBe('EN_COURS');
  });

  it('monthly() regroupe par mois de RÈGLEMENT, pas d’envoi — bug de convention confirmé par le PO (capture de référence)', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-08-15T10:00:00.000Z'));
      const r = await recours.create({ claimId: 'clm-settled-month', from: 'CAAT', to: 'SAA', amount: 12_000 });

      jest.setSystemTime(new Date('2026-09-10T08:00:00.000Z'));
      await recours.transition(r.id, { action: 'accepter' }, fakeUser('x')); // settledAt == septembre, requestSentAt == août

      const august = await settlement.monthly('2026-08');
      expect(august.companies.find((c) => c.code === 'CAAT')).toBeUndefined(); // plus compté sur le mois d'ENVOI

      const september = await settlement.monthly('2026-09');
      const caat = september.companies.find((c) => c.code === 'CAAT');
      expect(caat?.claimsCount).toBe(1); // compté sur le mois de RÈGLEMENT
      expect(caat?.resolvedCount).toBe(1);
      expect(caat?.totalAmount).toBe(12_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('monthly() exclut du calcul par compagnie les recours en OPPOSITION (RG-06) — confirmé par le PO', async () => {
    const r = await recours.create({ claimId: 'clm-opposition-month', from: 'CAAT', to: 'SAA', amount: 99_000 });
    await recours.transition(r.id, { action: 'opposer' }, fakeUser('x'));

    const period = new Date(r.requestSentAt).toISOString().slice(0, 7);
    const result = await settlement.monthly(period);
    expect(result.companies.find((c) => c.code === 'CAAT')).toBeUndefined();
  });

  it('closeMonthly() clôture une seule fois (409 ensuite) et persiste le bordereau', async () => {
    const r = await recours.create({ claimId: 'clm-3', from: 'CAAT', to: 'SAA', amount: 10_000 });
    const period = new Date(r.requestSentAt).toISOString().slice(0, 7);

    const closed = await settlement.closeMonthly(period, 'CAAT', 'tresorier.caat', fakeTresorier('CAAT'));
    expect(closed.status).toBe('CLOTURE');
    expect(closed.bordereauRef).toContain('CAAT');

    await expect(settlement.closeMonthly(period, 'CAAT', 'tresorier.caat', fakeTresorier('CAAT'))).rejects.toMatchObject({
      response: { code: 'ALREADY_CLOSED' },
    });

    const result = await settlement.monthly(period);
    expect(result.companies.find((c) => c.code === 'CAAT')?.status).toBe('CLOTURE');
  });

  /** Revue sécurité 2026-10-18 (B.7) : un TRESORIER ne doit clôturer que SA propre compagnie. */
  it("closeMonthly() refuse avec un 403 qu'un TRESORIER clôture la synthèse d'une AUTRE compagnie", async () => {
    const r = await recours.create({ claimId: 'clm-cross-tenant', from: 'SAA', to: 'CAAT', amount: 10_000 });
    const period = new Date(r.requestSentAt).toISOString().slice(0, 7);

    await expect(settlement.closeMonthly(period, 'SAA', 'tresorier.caat', fakeTresorier('CAAT'))).rejects.toMatchObject({
      response: { code: 'FORBIDDEN' },
    });

    const result = await settlement.monthly(period);
    expect(result.companies.find((c) => c.code === 'SAA')?.status).not.toBe('CLOTURE');
  });

  it('closeMonthly() autorise un rôle "place" (OPERATEUR_PLACE) à clôturer pour n\'importe quelle compagnie', async () => {
    const r = await recours.create({ claimId: 'clm-place-close', from: 'SAA', to: 'CAAT', amount: 5_000 });
    const period = new Date(r.requestSentAt).toISOString().slice(0, 7);

    const closed = await settlement.closeMonthly(period, 'SAA', 'operateur.place', fakeUser('operateur.place'));
    expect(closed.status).toBe('CLOTURE');
  });

  it('monthlySummary() calcule la bonne insertionDeadline (5e jour calendaire du mois suivant)', async () => {
    const result = await settlement.monthlySummary('2026-09');
    expect(result.period).toBe('2026-09');
    expect(result.insertionDeadline).toBe('2026-10-05');
  });

  it('monthlySummary() gère le passage à l’année suivante (décembre -> janvier)', async () => {
    const result = await settlement.monthlySummary('2026-12');
    expect(result.insertionDeadline).toBe('2027-01-05');
  });

  it('monthlySummary() exclut les recours en OPPOSITION du settledCount/totalAmount (ils ne sont jamais RÉGLÉS) et les compte dans excludedOppositionCount', async () => {
    const settled = await recours.create({ claimId: 'clm-sum-settled', from: 'CAAT', to: 'SAA', amount: 20_000 });
    const opposed = await recours.create({ claimId: 'clm-sum-opposed', from: 'CAAT', to: 'SAA', amount: 75_000 });
    await recours.transition(settled.id, { action: 'accepter' }, fakeUser('x'));
    await recours.transition(opposed.id, { action: 'opposer' }, fakeUser('x'));

    const period = new Date(settled.requestSentAt).toISOString().slice(0, 7);
    const result = await settlement.monthlySummary(period);

    expect(result.settledCount).toBe(1);
    expect(result.totalAmount).toBe(20_000);
    expect(result.excludedOppositionCount).toBe(1);
  });

  it('annexe7() regroupe les recours réglés du mois par paire créancier→débiteur EXACTE, sans netting', async () => {
    const a = await recours.create({ claimId: 'clm-a7-1', from: 'CAAT', to: 'SAA', amount: 50_000 });
    const b = await recours.create({ claimId: 'clm-a7-2', from: 'CAAT', to: 'SAA', amount: 30_000 });
    const c = await recours.create({ claimId: 'clm-a7-3', from: 'SAA', to: 'CAAT', amount: 10_000 });
    await recours.create({ claimId: 'clm-a7-4', from: 'CAAT', to: 'SAA', amount: 999_999 }); // jamais réglé : exclu
    await recours.transition(a.id, { action: 'accepter' }, fakeUser('x'));
    await recours.transition(b.id, { action: 'accepter' }, fakeUser('x'));
    await recours.transition(c.id, { action: 'accepter' }, fakeUser('x'));

    const period = new Date(a.requestSentAt).toISOString().slice(0, 7);
    const result = await settlement.annexe7(period);

    expect(result.period).toBe(period);
    expect(result.pairs).toEqual(
      expect.arrayContaining([
        { from: 'CAAT', to: 'SAA', count: 2, totalAmount: 80_000 },
        { from: 'SAA', to: 'CAAT', count: 1, totalAmount: 10_000 },
      ]),
    );
    expect(result.pairs).toHaveLength(2); // deux lignes orientées distinctes, pas de netting CAAT<->SAA
  });

  it('quarter() ne considère que les recours RÉGLÉS pour la compensation multilatérale', async () => {
    const a = await recours.create({ claimId: 'clm-a', from: 'CAAT', to: 'SAA', amount: 100_000 });
    const b = await recours.create({ claimId: 'clm-b', from: 'SAA', to: 'CAAT', amount: 40_000 });
    await recours.create({ claimId: 'clm-c', from: 'CASH', to: 'CAAT', amount: 999_999 }); // jamais réglé : exclu
    await recours.transition(a.id, { action: 'accepter' }, fakeUser('x'));
    await recours.transition(b.id, { action: 'accepter' }, fakeUser('x'));

    const q = `${new Date(a.requestSentAt).getUTCFullYear()}-Q${Math.floor(new Date(a.requestSentAt).getUTCMonth() / 3) + 1}`;
    const result = await settlement.quarter(q);

    expect(result.positions).toEqual([{ from: 'CAAT', to: 'SAA', amount: 60_000 }]);
    const sum = result.net.reduce((s, n) => s + n.net, 0);
    expect(Math.round(sum)).toBe(0);
    expect(result.net.find((n) => n.code === 'CASH')).toBeUndefined(); // dossier non réglé, jamais entré dans la matrice
  });

  it('matrix() renvoie la matrice brute (avant netting), limitée aux compagnies ayant au moins un recours réglé', async () => {
    const a = await recours.create({ claimId: 'clm-a2', from: 'CAAT', to: 'SAA', amount: 100_000 });
    const b = await recours.create({ claimId: 'clm-b2', from: 'SAA', to: 'CAAT', amount: 40_000 });
    await recours.create({ claimId: 'clm-c2', from: 'CASH', to: 'CAAT', amount: 999_999 }); // jamais réglé : exclu
    await recours.transition(a.id, { action: 'accepter' }, fakeUser('x'));
    await recours.transition(b.id, { action: 'accepter' }, fakeUser('x'));

    const q = `${new Date(a.requestSentAt).getUTCFullYear()}-Q${Math.floor(new Date(a.requestSentAt).getUTCMonth() / 3) + 1}`;
    const result = await settlement.matrix(q);

    expect(result.companies).toEqual(['CAAT', 'SAA']);
    expect(result.cells).toEqual(
      expect.arrayContaining([
        { from: 'CAAT', to: 'SAA', amount: 100_000 },
        { from: 'SAA', to: 'CAAT', amount: 40_000 },
      ]),
    );
  });

  it('summary() calcule le brut, le net multilatéral, la réduction des flux et les recours réglés/en opposition', async () => {
    const a = await recours.create({ claimId: 'clm-a3', from: 'CAAT', to: 'SAA', amount: 100_000 });
    const b = await recours.create({ claimId: 'clm-b3', from: 'SAA', to: 'CAAT', amount: 40_000 });
    const c = await recours.create({ claimId: 'clm-c3', from: 'CASH', to: 'CAAT', amount: 10_000 });
    await recours.transition(a.id, { action: 'accepter' }, fakeUser('x'));
    await recours.transition(b.id, { action: 'accepter' }, fakeUser('x'));
    await recours.transition(c.id, { action: 'opposer' }, fakeUser('x')); // en opposition — hors circuit, jamais réglé

    const q = `${new Date(a.requestSentAt).getUTCFullYear()}-Q${Math.floor(new Date(a.requestSentAt).getUTCMonth() / 3) + 1}`;
    const result = await settlement.summary(q);

    expect(result.grossTotal).toBe(140_000); // 100k + 40k, le recours en opposition n'entre jamais dans la matrice
    expect(result.bilateralNetTotal).toBe(60_000); // CAAT -> SAA net
    expect(result.multilateralNetTotal).toBe(60_000); // 2 compagnies : net multilatéral == net bilatéral ici
    expect(result.reductionPct).toBeCloseTo(57.1, 1);
    expect(result.settledCount).toBe(2);
    expect(result.opposedCount).toBe(1);
  });

  it('summary() ne divise jamais par zéro quand aucun recours n’est réglé ce trimestre', async () => {
    const result = await settlement.summary('2099-Q1');
    expect(result).toMatchObject({ grossTotal: 0, bilateralNetTotal: 0, multilateralNetTotal: 0, reductionPct: 0, settledCount: 0 });
  });

  it('closeQuarterly() est idempotent (409 si déjà clôturé) et expose le bordereau sur quarter() ensuite', async () => {
    const now = new Date();
    const q = `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
    const closed = await settlement.closeQuarterly(q, 'operateur.place');
    expect(closed.bordereau).toContain(q);

    await expect(settlement.closeQuarterly(q, 'operateur.place')).rejects.toMatchObject({ response: { code: 'ALREADY_CLOSED' } });

    const result = await settlement.quarter(q);
    expect(result.bordereau).toBe(closed.bordereau);
    expect(result.closedBy).toBe('operateur.place');
  });
});
