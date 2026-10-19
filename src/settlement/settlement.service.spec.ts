import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { LedgerService } from '../ledger/ledger.service';
import { RecoursViewDto } from '../recours/dto/recours.dto';
import { Recours } from '../recours/entities/recours.entity';
import { toCents } from '../recours/money';
import { RecoursService } from '../recours/recours.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import { SettlementClosure } from './entities/settlement-closure.entity';
import { SettlementService } from './settlement.service';
import { simulatedDatabaseOutage } from '../common/database/db-errors';

/** Acteur "place". */
function placeUser(name = 'operateur.place'): AuthenticatedUser {
  return { id: `id-${name}`, name, email: `${name}@test.local`, role: 'OPERATEUR_PLACE', privileges: ['closeQuarter', 'synth'] };
}

/** Acteur scopé compagnie (TRESORIER). */
function fakeTresorier(companyId: string): AuthenticatedUser {
  return { id: 't', name: `tresorier.${companyId.toLowerCase()}`, email: 't@test.local', role: 'TRESORIER', companyId, privileges: ['synth'] };
}

function correspondant(companyId: string): AuthenticatedUser {
  return { id: `c-${companyId}`, name: `corr.${companyId}`, email: 'c@test.local', role: 'CORRESPONDANT_IDA', companyId, privileges: ['exchange'] };
}

/** Repli mémoire forcé — voir recours.service.spec.ts. */
function failingEm(): Record<string, jest.Mock> {
  const fail = () => Promise.reject(simulatedDatabaseOutage());
  const em: Record<string, jest.Mock> = { find: jest.fn(fail), findOne: jest.fn(fail), transactional: jest.fn(fail), persistAndFlush: jest.fn(fail), flush: jest.fn(fail) };
  em.fork = jest.fn(() => em);
  return em;
}

function throwingRepo() {
  return {
    create: jest.fn((data: unknown) => data),
    find: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    findOne: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    findAll: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    getEntityManager: jest.fn(() => failingEm()),
  };
}

function fakeConfigService() {
  return { get: () => undefined } as unknown as ConfigService;
}

const quarterOf = (iso: string) => `${new Date(iso).getUTCFullYear()}-Q${Math.floor(new Date(iso).getUTCMonth() / 3) + 1}`;

describe('SettlementService (mode dégradé — synthèse mensuelle, compensation trimestrielle)', () => {
  let settlement: SettlementService;
  let recours: RecoursService;
  let ledgerAppend: jest.Mock;

  const accept = (r: RecoursViewDto) => recours.transition(r.id, { action: 'accepter' }, correspondant(r.to));
  const oppose = (r: RecoursViewDto) => recours.transition(r.id, { action: 'opposer' }, correspondant(r.to));

  beforeEach(async () => {
    ledgerAppend = jest.fn(async () => ({}));
    const moduleRef = await Test.createTestingModule({
      providers: [
        SettlementService,
        RecoursService,
        { provide: getRepositoryToken(SettlementClosure), useFactory: throwingRepo },
        { provide: getRepositoryToken(Recours), useFactory: throwingRepo },
        { provide: ConfigService, useFactory: fakeConfigService },
        { provide: RealtimeGateway, useValue: { emitEvent: jest.fn() } },
        { provide: LedgerService, useValue: { append: ledgerAppend } },
      ],
    }).compile();

    settlement = moduleRef.get(SettlementService);
    recours = moduleRef.get(RecoursService);
  });

  afterEach(() => jest.useRealTimers());

  it('monthly() rejette un format de période invalide avec un 400 normalisé', async () => {
    await expect(settlement.monthly('2026/01')).rejects.toMatchObject({ response: { code: 'BAD_REQUEST' } });
  });

  it('quarter() rejette un format de trimestre invalide avec un 400 normalisé', async () => {
    await expect(settlement.quarter('2026-Q9')).rejects.toMatchObject({ response: { code: 'BAD_REQUEST' } });
  });

  it('SEC-34 : monthly() ne retient que les recours RÉGLÉS, par compagnie demanderesse', async () => {
    const settled = await recours.create({ claimId: 'clm-1', from: 'CAAT', to: 'SAA', amount: 50_000 });
    await recours.create({ claimId: 'clm-2', from: 'CAAT', to: 'SAA', amount: 30_000 }); // en attente : hors synthèse
    await accept(settled);

    const result = await settlement.monthly(new Date(settled.requestSentAt).toISOString().slice(0, 7));
    const caat = result.companies.find((c) => c.code === 'CAAT');
    expect(caat).toMatchObject({ claimsCount: 1, resolvedCount: 1, totalAmount: 50_000, status: 'EN_COURS' });
  });

  it('SEC-34 : un recours n’apparaît que dans UN mois — jamais au mois d’envoi puis au mois de règlement', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-15T10:00:00.000Z'));
    const r = await recours.create({ claimId: 'clm-settled-month', from: 'CAAT', to: 'SAA', amount: 12_000 });
    // Avant règlement : le recours (en attente) n'entre dans aucune synthèse mensuelle.
    expect((await settlement.monthly('2026-08')).companies.find((c) => c.code === 'CAAT')).toBeUndefined();

    jest.setSystemTime(new Date('2026-09-10T08:00:00.000Z'));
    await accept(r);

    expect((await settlement.monthly('2026-08')).companies.find((c) => c.code === 'CAAT')).toBeUndefined();
    const caat = (await settlement.monthly('2026-09')).companies.find((c) => c.code === 'CAAT');
    expect(caat).toMatchObject({ claimsCount: 1, resolvedCount: 1, totalAmount: 12_000 });
  });

  it('monthly() exclut les recours en OPPOSITION (RG-06)', async () => {
    const r = await recours.create({ claimId: 'clm-opposition-month', from: 'CAAT', to: 'SAA', amount: 99_000 });
    await oppose(r);
    const result = await settlement.monthly(new Date(r.requestSentAt).toISOString().slice(0, 7));
    expect(result.companies.find((c) => c.code === 'CAAT')).toBeUndefined();
  });

  describe('SEC-19 — clôtures', () => {
    it('closeMonthly() : période échue uniquement, une seule fois (409 ensuite), instantané scellé au journal', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));
      const r = await recours.create({ claimId: 'clm-3', from: 'CAAT', to: 'SAA', amount: 10_000 });
      await accept(r);

      // Mois en cours : clôture refusée.
      await expect(settlement.closeMonthly('2026-01', 'CAAT', 'tresorier.caat', fakeTresorier('CAAT'))).rejects.toMatchObject({ status: 409, response: { code: 'PERIODE_NON_ECHUE' } });

      jest.setSystemTime(new Date('2026-02-03T10:00:00.000Z'));
      const closed = await settlement.closeMonthly('2026-01', 'CAAT', 'tresorier.caat', fakeTresorier('CAAT'));
      expect(closed).toMatchObject({ status: 'CLOTURE', claimsCount: 1, totalAmount: 10_000 });
      expect(closed.bordereauRef).toContain('CAAT');
      expect(ledgerAppend).toHaveBeenCalledWith('CLOTURE_MENSUELLE', 'BORD-M-2026-01-CAAT', 't', expect.stringMatching(/"snapshotHash":"[0-9a-f]{64}"/));

      await expect(settlement.closeMonthly('2026-01', 'CAAT', 'tresorier.caat', fakeTresorier('CAAT'))).rejects.toMatchObject({ response: { code: 'ALREADY_CLOSED' } });
      expect((await settlement.monthly('2026-01')).companies.find((c) => c.code === 'CAAT')?.status).toBe('CLOTURE');
    });

    it("closeMonthly() refuse avec un 403 qu'un TRESORIER clôture la synthèse d'une AUTRE compagnie", async () => {
      await expect(settlement.closeMonthly('2025-01', 'SAA', 'tresorier.caat', fakeTresorier('CAAT'))).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
    });

    it('closeMonthly() autorise un rôle place à clôturer pour n’importe quelle compagnie (période échue)', async () => {
      const closed = await settlement.closeMonthly('2025-03', 'SAA', 'operateur.place', placeUser());
      expect(closed.status).toBe('CLOTURE');
    });

    it('closeQuarterly() : trimestre en cours refusé (409), 409 si déjà clôturé, réservé aux rôles place (403 même avec le privilège)', async () => {
      const now = new Date();
      const current = quarterOf(now.toISOString());
      await expect(settlement.closeQuarterly(current, placeUser())).rejects.toMatchObject({ status: 409, response: { code: 'PERIODE_NON_ECHUE' } });
      await expect(settlement.closeQuarterly('2025-Q1', { ...fakeTresorier('CAAT'), privileges: ['closeQuarter'] })).rejects.toMatchObject({ status: 403 });

      const closed = await settlement.closeQuarterly('2025-Q1', placeUser());
      expect(closed.bordereau).toBe('BORD-Q-2025-Q1');
      await expect(settlement.closeQuarterly('2025-Q1', placeUser())).rejects.toMatchObject({ response: { code: 'ALREADY_CLOSED' } });
      expect(ledgerAppend).toHaveBeenCalledWith('CLOTURE_TRIMESTRIELLE', 'BORD-Q-2025-Q1', 'id-operateur.place', expect.stringMatching(/"snapshotHash":"[0-9a-f]{64}"/));
    });

    it('deux clôtures concurrentes du même trimestre : une seule réussit', async () => {
      const results = await Promise.allSettled([settlement.closeQuarterly('2025-Q2', placeUser()), settlement.closeQuarterly('2025-Q2', placeUser('autre'))]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.getStatus()).toBe(409);
      expect((await settlement.quarterlyClosures()).filter((c) => c.period === '2025-Q2')).toHaveLength(1);
    });

    it('les montants d’une période clôturée ne changent plus : quarter()/matrix()/summary() renvoient l’instantané', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-02-10T09:00:00.000Z'));
      const a = await recours.create({ claimId: 'clm-snap-a', from: 'CAAT', to: 'SAA', amount: 100_000 });
      await accept(a);

      jest.setSystemTime(new Date('2026-04-20T09:00:00.000Z'));
      const closed = await settlement.closeQuarterly('2026-Q1', placeUser());
      expect(closed.positions).toEqual([{ from: 'CAAT', to: 'SAA', amount: 100_000 }]);

      // Un recours réglé APRÈS la clôture mais daté du trimestre clos (ex. relevé tardif) ne modifie pas le bordereau scellé.
      jest.setSystemTime(new Date('2026-03-15T09:00:00.000Z'));
      const late = await recours.create({ claimId: 'clm-snap-late', from: 'SAA', to: 'CAAT', amount: 40_000 });
      await accept(late);
      jest.setSystemTime(new Date('2026-04-21T09:00:00.000Z'));

      expect((await settlement.quarter('2026-Q1')).positions).toEqual([{ from: 'CAAT', to: 'SAA', amount: 100_000 }]);
      expect((await settlement.matrix('2026-Q1')).cells).toEqual([{ from: 'CAAT', to: 'SAA', amount: 100_000 }]);
      expect(await settlement.summary('2026-Q1')).toMatchObject({ grossTotal: 100_000, settledCount: 1 });
    });

    it('SEC-26 : quarterlyClosures() et quarter() ne renvoient pas l’auteur de la clôture aux rôles compagnie', async () => {
      await settlement.closeQuarterly('2025-Q3', placeUser());
      expect((await settlement.quarterlyClosures(placeUser()))[0]).toHaveProperty('closedBy', 'operateur.place');
      const forCompany = await settlement.quarterlyClosures(fakeTresorier('CAAT'));
      expect(forCompany[0]).not.toHaveProperty('closedBy');
      expect((await settlement.quarter('2025-Q3', fakeTresorier('CAAT'))).closedBy).toBeUndefined();
      expect((await settlement.quarter('2025-Q3', placeUser())).closedBy).toBe('operateur.place');
    });
  });

  it('monthlySummary() calcule la bonne insertionDeadline (5e jour calendaire du mois suivant)', async () => {
    const result = await settlement.monthlySummary('2026-09');
    expect(result).toMatchObject({ period: '2026-09', insertionDeadline: '2026-10-05' });
    expect((await settlement.monthlySummary('2026-12')).insertionDeadline).toBe('2027-01-05');
  });

  it('monthlySummary() exclut les recours en OPPOSITION du settledCount/totalAmount et les compte dans excludedOppositionCount', async () => {
    const settled = await recours.create({ claimId: 'clm-sum-settled', from: 'CAAT', to: 'SAA', amount: 20_000 });
    const opposed = await recours.create({ claimId: 'clm-sum-opposed', from: 'CAAT', to: 'SAA', amount: 75_000 });
    await accept(settled);
    await oppose(opposed);

    const result = await settlement.monthlySummary(new Date(settled.requestSentAt).toISOString().slice(0, 7));
    expect(result).toMatchObject({ settledCount: 1, totalAmount: 20_000, excludedOppositionCount: 1 });
  });

  it('annexe7() regroupe les recours réglés du mois par paire créancier→débiteur EXACTE, sans netting', async () => {
    const a = await recours.create({ claimId: 'clm-a7-1', from: 'CAAT', to: 'SAA', amount: 50_000 });
    const b = await recours.create({ claimId: 'clm-a7-2', from: 'CAAT', to: 'SAA', amount: 30_000 });
    const c = await recours.create({ claimId: 'clm-a7-3', from: 'SAA', to: 'CAAT', amount: 10_000 });
    await recours.create({ claimId: 'clm-a7-4', from: 'CAAT', to: 'SAA', amount: 299_999 }); // jamais réglé : exclu
    await accept(a);
    await accept(b);
    await accept(c);

    const period = new Date(a.requestSentAt).toISOString().slice(0, 7);
    const result = await settlement.annexe7(period);
    expect(result.pairs).toEqual(
      expect.arrayContaining([
        { from: 'CAAT', to: 'SAA', count: 2, totalAmount: 80_000 },
        { from: 'SAA', to: 'CAAT', count: 1, totalAmount: 10_000 },
      ]),
    );
    expect(result.pairs).toHaveLength(2);
  });

  it('quarter() ne considère que les recours RÉGLÉS ; la somme multilatérale vaut exactement 0', async () => {
    const a = await recours.create({ claimId: 'clm-a', from: 'CAAT', to: 'SAA', amount: 100_000.1 });
    const b = await recours.create({ claimId: 'clm-b', from: 'SAA', to: 'CAAT', amount: 40_000.2 });
    await recours.create({ claimId: 'clm-c', from: 'CASH', to: 'CAAT', amount: 299_999 }); // jamais réglé : exclu
    await accept(a);
    await accept(b);

    const result = await settlement.quarter(quarterOf(a.requestSentAt));
    expect(result.positions).toEqual([{ from: 'CAAT', to: 'SAA', amount: 59_999.9 }]);
    expect(result.net.reduce((s, n) => s + toCents(n.net), 0)).toBe(0);
    expect(result.net.find((n) => n.code === 'CASH')).toBeUndefined();
  });

  it('matrix() renvoie la matrice brute (avant netting), limitée aux compagnies ayant au moins un recours réglé', async () => {
    const a = await recours.create({ claimId: 'clm-a2', from: 'CAAT', to: 'SAA', amount: 100_000 });
    const b = await recours.create({ claimId: 'clm-b2', from: 'SAA', to: 'CAAT', amount: 40_000 });
    await recours.create({ claimId: 'clm-c2', from: 'CASH', to: 'CAAT', amount: 299_999 });
    await accept(a);
    await accept(b);

    const result = await settlement.matrix(quarterOf(a.requestSentAt));
    expect(result.companies).toEqual(['CAAT', 'SAA']);
    expect(result.cells).toEqual(expect.arrayContaining([{ from: 'CAAT', to: 'SAA', amount: 100_000 }, { from: 'SAA', to: 'CAAT', amount: 40_000 }]));
  });

  it('summary() calcule le brut, le net multilatéral, la réduction des flux et les recours réglés/en opposition', async () => {
    const a = await recours.create({ claimId: 'clm-a3', from: 'CAAT', to: 'SAA', amount: 100_000 });
    const b = await recours.create({ claimId: 'clm-b3', from: 'SAA', to: 'CAAT', amount: 40_000 });
    const c = await recours.create({ claimId: 'clm-c3', from: 'CASH', to: 'CAAT', amount: 10_000 });
    await accept(a);
    await accept(b);
    await oppose(c);

    const result = await settlement.summary(quarterOf(a.requestSentAt));
    expect(result).toMatchObject({ grossTotal: 140_000, bilateralNetTotal: 60_000, multilateralNetTotal: 60_000, settledCount: 2, opposedCount: 1 });
    expect(result.reductionPct).toBeCloseTo(57.1, 1);
  });

  it('summary() ne divise jamais par zéro quand aucun recours n’est réglé ce trimestre', async () => {
    const result = await settlement.summary('2099-Q1');
    expect(result).toMatchObject({ grossTotal: 0, bilateralNetTotal: 0, multilateralNetTotal: 0, reductionPct: 0, settledCount: 0 });
  });

  it('quarterlyClosures() renvoie [] quand aucun trimestre n’a encore été clôturé', async () => {
    expect(await settlement.quarterlyClosures()).toEqual([]);
  });

  it('quarterlyClosures() ne renvoie QUE les trimestres effectivement clôturés', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-02-10T09:00:00.000Z'));
    const q1 = await recours.create({ claimId: 'clm-closures-q1', from: 'CAAT', to: 'SAA', amount: 15_000 });
    await accept(q1);
    jest.setSystemTime(new Date('2026-05-10T09:00:00.000Z'));
    const q2 = await recours.create({ claimId: 'clm-closures-q2', from: 'CAAT', to: 'SAA', amount: 25_000 });
    await accept(q2);

    expect(await settlement.quarterlyClosures()).toEqual([]);
    const closed = await settlement.closeQuarterly('2026-Q1', placeUser());
    const result = await settlement.quarterlyClosures();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ period: '2026-Q1', closedBy: 'operateur.place', closedAt: closed.closedAt });
    expect(result.find((c) => c.period === '2026-Q2')).toBeUndefined();
  });
});
