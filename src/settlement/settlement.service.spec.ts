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

  it('monthly() regroupe les recours par compagnie demanderesse sur le mois d’envoi', async () => {
    // Deux recours CAAT en janvier 2026 (un réglé, un en attente), un recours SAA en février (hors période).
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

  it('closeMonthly() clôture une seule fois (409 ensuite) et persiste le bordereau', async () => {
    const r = await recours.create({ claimId: 'clm-3', from: 'CAAT', to: 'SAA', amount: 10_000 });
    const period = new Date(r.requestSentAt).toISOString().slice(0, 7);

    const closed = await settlement.closeMonthly(period, 'CAAT', 'tresorier.caat');
    expect(closed.status).toBe('CLOTURE');
    expect(closed.bordereauRef).toContain('CAAT');

    await expect(settlement.closeMonthly(period, 'CAAT', 'tresorier.caat')).rejects.toMatchObject({
      response: { code: 'ALREADY_CLOSED' },
    });

    const result = await settlement.monthly(period);
    expect(result.companies.find((c) => c.code === 'CAAT')?.status).toBe('CLOTURE');
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
