import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { RealtimeGateway } from '../realtime/realtime.module';
import { Recours } from './entities/recours.entity';
import { RecoursService } from './recours.service';

/** Acteur "place" (OPERATEUR_PLACE) — aucune restriction de côté, préserve le comportement des tests écrits avant l'ajout du scoping par compagnie (revue Product Owner, sprint 3). */
function fakeUser(name: string): AuthenticatedUser {
  return { id: name, name, email: `${name}@test.local`, role: 'OPERATEUR_PLACE', privileges: [] };
}

/** Repli mémoire forcé : toute opération dépendant de la base échoue (voir claims.service.spec.ts). */
function throwingRepo() {
  return {
    create: jest.fn((data: unknown) => data),
    findOne: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    findAll: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    getEntityManager: jest.fn(() => ({
      persist: jest.fn(),
      persistAndFlush: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
      flush: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    })),
  };
}

function fakeConfigService(overrides: Record<string, string> = {}) {
  return { get: (key: string) => overrides[key] } as unknown as ConfigService;
}

describe('RecoursService (mode dégradé — timers Art.10/12/19, machine d’état)', () => {
  let service: RecoursService;
  let emitEvent: jest.Mock;

  async function buildService(overrides: Record<string, string> = {}) {
    emitEvent = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RecoursService,
        { provide: getRepositoryToken(Recours), useFactory: throwingRepo },
        { provide: ConfigService, useFactory: () => fakeConfigService(overrides) },
        { provide: RealtimeGateway, useValue: { emitEvent } },
      ],
    }).compile();
    return moduleRef.get(RecoursService);
  }

  beforeEach(async () => {
    service = await buildService();
  });

  it('crée un recours en repli mémoire, visible via list() et get()', async () => {
    const created = await service.create({ claimId: 'clm-1', from: 'CAAT', to: 'SAA', amount: 85_000 });
    expect(created.state).toBe('EN_ATTENTE');
    expect(created.timer.timerType).toBe('SILENCE_ART10');
    expect(created.timer.expired).toBe(false);

    const list = await service.list({ filter: 'TOUS', page: 1, pageSize: 6 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0].id).toBe(created.id);

    const detail = await service.get(created.id);
    expect(detail.from).toBe('CAAT');
    expect(detail.to).toBe('SAA');
    expect(detail.amount).toBe(85_000);
  });

  it('list() filtre par recherche libre (q) sur l’id recours, le dossier lié ou la compagnie from/to', async () => {
    const a = await service.create({ claimId: 'clm-caat-saa', from: 'CAAT', to: 'SAA', amount: 10_000 });
    await service.create({ claimId: 'clm-cash-caar', from: 'CASH', to: 'CAAR', amount: 20_000 });

    const byClaim = await service.list({ filter: 'TOUS', page: 1, pageSize: 6, q: 'clm-caat-saa' });
    expect(byClaim.items.map((r) => r.id)).toEqual([a.id]);

    const byCompany = await service.list({ filter: 'TOUS', page: 1, pageSize: 6, q: 'caar' }); // insensible à la casse
    expect(byCompany.items).toHaveLength(1);
    expect(byCompany.items[0].to).toBe('CAAR');

    const noMatch = await service.list({ filter: 'TOUS', page: 1, pageSize: 6, q: 'inconnu' });
    expect(noMatch.items).toHaveLength(0);
  });

  it('get() lève un 404 normalisé pour un id inconnu', async () => {
    await expect(service.get('inconnu')).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });

  it('transition "accepter" : EN_ATTENTE -> REGLE, émet recours.timer', async () => {
    const created = await service.create({ claimId: 'clm-2', from: 'CAAT', to: 'SAA', amount: 50_000 });
    const result = await service.transition(created.id, { action: 'accepter' }, fakeUser('correspondant.caat'));
    expect(result.state).toBe('REGLE');
    expect(result.timer.timerType).toBe('AUCUN');
    expect(emitEvent).toHaveBeenCalledWith('recours.timer', expect.objectContaining({ id: created.id, state: 'REGLE' }));

    const detail = await service.get(created.id);
    expect(detail.state).toBe('REGLE');
    expect(detail.resolution?.kind).toBe('ACCEPTATION_EXPRESSE');
  });

  it('transition invalide (action non autorisée dans l’état courant) renvoie un 400 normalisé, jamais un faux 404', async () => {
    const created = await service.create({ claimId: 'clm-3', from: 'CAAT', to: 'SAA', amount: 30_000 });
    // "contester" n'est autorisé que depuis OPPOSITION, pas depuis EN_ATTENTE.
    await expect(service.transition(created.id, { action: 'contester' }, fakeUser('x'))).rejects.toMatchObject({
      response: { code: 'INVALID_TRANSITION' },
    });
  });

  it('transition sur un id inconnu renvoie un 404 normalisé', async () => {
    await expect(service.transition('inconnu', { action: 'accepter' }, fakeUser('x'))).rejects.toMatchObject({
      response: { code: 'NOT_FOUND' },
    });
  });

  it('opposer puis contester puis transmettre_commission : parcours complet jusqu’en commission', async () => {
    const created = await service.create({ claimId: 'clm-4', from: 'CAAT', to: 'SAA', amount: 120_000 });
    await service.transition(created.id, { action: 'opposer', reason: 'Montant contesté' }, fakeUser('saa.correspondant'));
    let detail = await service.get(created.id);
    expect(detail.state).toBe('OPPOSITION');
    expect(detail.opposition?.status).toBe('EN_COURS');
    expect(detail.timer.timerType).toBe('OPPOSITION_ART12');

    await service.transition(created.id, { action: 'contester', reason: 'Désaccord sur le motif' }, fakeUser('caat.correspondant'));
    detail = await service.get(created.id);
    expect(detail.state).toBe('CONTESTATION');

    await service.transition(created.id, { action: 'transmettre_commission' }, fakeUser('caat.correspondant'));
    detail = await service.get(created.id);
    expect(detail.state).toBe('COMMISSION');
    expect(detail.commissionAt).toBeDefined();
  });

  it('listAll() (interface publique inter-modules) reflète le repli mémoire sans exposer de champs internes', async () => {
    await service.create({ claimId: 'clm-5', from: 'CAAT', to: 'SAA', amount: 10_000 });
    const all = await service.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]).not.toHaveProperty('__internal');
  });

  it('counters() dénombre correctement par état', async () => {
    const a = await service.create({ claimId: 'clm-6', from: 'CAAT', to: 'SAA', amount: 1000 });
    await service.create({ claimId: 'clm-7', from: 'SAA', to: 'CASH', amount: 2000 });
    await service.transition(a.id, { action: 'accepter' }, fakeUser('x'));

    const counters = await service.counters();
    expect(counters.TOUS).toBe(2);
    expect(counters.REGLE).toBe(1);
    expect(counters.EN_ATTENTE).toBe(1);
  });

  it('utilise RECOURS_SILENCE_DAYS/RECOURS_OPPOSITION_DAYS/ELIGIBILITY_RECOURS_MAX_MONTHS si fournis (paramétrable)', async () => {
    const custom = await buildService({ RECOURS_SILENCE_DAYS: '5', RECOURS_OPPOSITION_DAYS: '3', ELIGIBILITY_RECOURS_MAX_MONTHS: '1' });
    expect(custom.getTimerConfig()).toEqual({ silenceDays: 5, oppositionDays: 3, forclusionMonths: 1 });
  });
});
