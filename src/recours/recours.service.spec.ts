import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AdherentsService } from '../adherents/adherents.service';
import { ConventionReferentialService } from '../adherents/convention-referential.service';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { LedgerService } from '../ledger/ledger.service';
import { PLACE_ROOM, RealtimeGateway, tenantRoom } from '../realtime/realtime.module';
import { Recours } from './entities/recours.entity';
import { CommissionDecisionForRecours, RecoursService } from './recours.service';
import { simulatedDatabaseOutage, simulatedOutageEntityManager } from '../common/database/db-errors';

/** Acteur "place" (OPERATEUR_PLACE). */
function placeUser(name = 'operateur'): AuthenticatedUser {
  return { id: `id-${name}`, name, email: `${name}@test.local`, role: 'OPERATEUR_PLACE', privileges: [] };
}

/** Acteur rattaché à une compagnie. */
function correspondant(companyId: string, name = `corr.${companyId}`): AuthenticatedUser {
  return { id: `id-${name}`, name, email: `${name}@test.local`, role: 'CORRESPONDANT_IDA', companyId, privileges: ['exchange'] };
}

/** Repli mémoire forcé : toute opération dépendant de la base échoue (voir claims.service.spec.ts). */
function failingEm(): Record<string, jest.Mock> {
  const fail = () => Promise.reject(simulatedDatabaseOutage());
  const em: Record<string, jest.Mock> = {
    find: jest.fn(fail),
    findOne: jest.fn(fail),
    transactional: jest.fn(fail),
    persistAndFlush: jest.fn(fail),
    flush: jest.fn(fail),
  };
  em.fork = jest.fn(() => em);
  em.getContext = jest.fn(() => em);
  return em;
}

function throwingRepo() {
  return {
    create: jest.fn((data: unknown) => data),
    findOne: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    findAll: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    getEntityManager: jest.fn(() => failingEm()),
  };
}

function fakeConfigService(overrides: Record<string, string> = {}) {
  return { get: (key: string) => overrides[key] } as unknown as ConfigService;
}

describe('RecoursService (mode dégradé — timers Art.10/12/19, machine d’état)', () => {
  let service: RecoursService;
  let emitEvent: jest.Mock;
  let ledgerAppend: jest.Mock;

  async function buildService(overrides: Record<string, string> = {}) {
    emitEvent = jest.fn();
    ledgerAppend = jest.fn(async () => ({}));
    const moduleRef = await Test.createTestingModule({
      providers: [
        RecoursService,
        { provide: getRepositoryToken(Recours), useFactory: throwingRepo },
        { provide: ConfigService, useFactory: () => fakeConfigService(overrides) },
        { provide: RealtimeGateway, useValue: { emitEvent } },
        { provide: LedgerService, useValue: { append: ledgerAppend } },
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
    expect(detail).toMatchObject({ from: 'CAAT', to: 'SAA', amount: 85_000 });
  });

  it('list() filtre par recherche libre (q) sur l’id recours, le dossier lié ou la compagnie from/to', async () => {
    const a = await service.create({ claimId: 'clm-caat-saa', from: 'CAAT', to: 'SAA', amount: 10_000 });
    await service.create({ claimId: 'clm-cash-caar', from: 'CASH', to: 'CAAR', amount: 20_000 });

    const byClaim = await service.list({ filter: 'TOUS', page: 1, pageSize: 6, q: 'clm-caat-saa' });
    expect(byClaim.items.map((r) => r.id)).toEqual([a.id]);
    const byCompany = await service.list({ filter: 'TOUS', page: 1, pageSize: 6, q: 'caar' });
    expect(byCompany.items).toHaveLength(1);
    expect((await service.list({ filter: 'TOUS', page: 1, pageSize: 6, q: 'inconnu' })).items).toHaveLength(0);
  });

  it('attribue une référence métier REC-AAAA-NNNNN séquentielle, recherchable par q', async () => {
    const year = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Algiers', year: 'numeric' }).format(new Date());
    const a = await service.create({ claimId: 'clm-ref-1', from: 'CAAT', to: 'SAA', amount: 1_000 });
    const b = await service.create({ claimId: 'clm-ref-2', from: 'CASH', to: 'CAAR', amount: 2_000 });
    expect([a.reference, b.reference]).toEqual([`REC-${year}-00001`, `REC-${year}-00002`]);
    expect((await service.get(a.id)).reference).toBe(a.reference);
    const byRef = await service.list({ filter: 'TOUS', page: 1, pageSize: 6, q: b.reference.toLowerCase() });
    expect(byRef.items.map((r) => r.id)).toEqual([b.id]);
  });

  it('la référence ne change pas au fil des transitions', async () => {
    const r = await service.create({ claimId: 'clm-ref-3', from: 'CAAT', to: 'SAA', amount: 1_000 });
    await service.transition(r.id, { action: 'opposer', reason: 'Montant' }, correspondant('SAA'));
    expect((await service.get(r.id)).reference).toBe(r.reference);
  });

  it('get() lève un 404 normalisé pour un id inconnu', async () => {
    await expect(service.get('inconnu')).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });

  describe('SEC-06 — montant borné', () => {
    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['1e308', 1e308],
      ['zéro', 0],
      ['négatif', -10],
      ['3 décimales', 100.123],
    ])('refuse un montant %s (400 MONTANT_INVALIDE)', async (_label, amount) => {
      await expect(service.create({ claimId: `clm-${_label}`, from: 'CAAT', to: 'SAA', amount })).rejects.toMatchObject({ status: 400, response: { code: 'MONTANT_INVALIDE' } });
    });

    it('refuse un montant supérieur au plafond conventionnel (ELIGIBILITY_MAX_AMOUNT_DA) — 400 RECOURS_MONTANT_PLAFOND', async () => {
      const capped = await buildService({ ELIGIBILITY_MAX_AMOUNT_DA: '300000' });
      await expect(capped.create({ claimId: 'clm-cap', from: 'CAAT', to: 'SAA', amount: 300_000.01 })).rejects.toMatchObject({ response: { code: 'RECOURS_MONTANT_PLAFOND' } });
      await expect(capped.create({ claimId: 'clm-cap-ok', from: 'CAAT', to: 'SAA', amount: 300_000 })).resolves.toMatchObject({ amount: 300_000 });
    });

    it('accepte deux décimales exactes', async () => {
      await expect(service.create({ claimId: 'clm-cents', from: 'CAAT', to: 'SAA', amount: 1234.56 })).resolves.toMatchObject({ amount: 1234.56 });
    });

    it('refuse un recours d’une compagnie contre elle-même', async () => {
      await expect(service.create({ claimId: 'clm-self', from: 'CAAT', to: 'CAAT', amount: 10 })).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('SEC-20 — un seul recours par dossier', () => {
    it('un second recours sur le même dossier est refusé (409 RECOURS_EXISTANT)', async () => {
      await service.create({ claimId: 'clm-dup', from: 'CAAT', to: 'SAA', amount: 10 });
      await expect(service.create({ claimId: 'clm-dup', from: 'CAAT', to: 'SAA', amount: 10 })).rejects.toMatchObject({ status: 409, response: { code: 'RECOURS_EXISTANT' } });
    });

    it('deux ouvertures concurrentes sur le même dossier : une seule réussit, l’autre reçoit 409', async () => {
      const results = await Promise.allSettled([
        service.create({ claimId: 'clm-race', from: 'CAAT', to: 'SAA', amount: 10 }),
        service.create({ claimId: 'clm-race', from: 'CAAT', to: 'SAA', amount: 10 }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason.getStatus()).toBe(409);
      expect((await service.listAll()).filter((r) => r.claimId === 'clm-race')).toHaveLength(1);
    });
  });

  describe('SEC-07 — temps réel limité aux parties, payload minimal', () => {
    it('l’ouverture et chaque transition visent PLACE_ROOM + les deux compagnies, avec { id, reference, state } seulement', async () => {
      const created = await service.create({ claimId: 'clm-rt', from: 'CAAT', to: 'SAA', amount: 10 });
      await service.transition(created.id, { action: 'opposer', reason: 'Montant' }, correspondant('SAA'));
      for (const call of emitEvent.mock.calls) {
        const [event, payload, opts] = call;
        expect(event).toBe('recours.timer');
        expect(Object.keys(payload).sort()).toEqual(['id', 'reference', 'state']);
        expect(opts.rooms).toEqual([PLACE_ROOM, tenantRoom('CAAT'), tenantRoom('SAA')]);
        expect(JSON.stringify(payload)).not.toMatch(/corr\.|decidedBy|resolution/);
      }
      expect(emitEvent).toHaveBeenCalledWith('recours.timer', { id: created.id, reference: created.reference, state: 'OPPOSITION' }, expect.anything());
    });
  });

  describe('SEC-17 — acteur et preuve de chaque transition', () => {
    it('persiste auteur (id), rôle, compagnie représentée et motif, et scelle au journal', async () => {
      const created = await service.create({ claimId: 'clm-h', from: 'CAAT', to: 'SAA', amount: 10 }, placeUser('op1'));
      await service.transition(created.id, { action: 'opposer', reason: 'Montant contesté' }, correspondant('SAA', 'agent.saa'));
      await service.transition(created.id, { action: 'contester', reason: 'Désaccord' }, correspondant('CAAT', 'agent.caat'));

      const history = await service.history(created.id, placeUser());
      expect(history).toEqual([
        expect.objectContaining({ action: 'creation', toState: 'EN_ATTENTE', actorId: 'id-op1', actorRole: 'OPERATEUR_PLACE' }),
        expect.objectContaining({ action: 'opposer', fromState: 'EN_ATTENTE', toState: 'OPPOSITION', actorId: 'id-agent.saa', actorRole: 'CORRESPONDANT_IDA', onBehalfOf: 'SAA', reason: 'Montant contesté' }),
        expect.objectContaining({ action: 'contester', fromState: 'OPPOSITION', toState: 'CONTESTATION', actorId: 'id-agent.caat', onBehalfOf: 'CAAT' }),
      ]);
      expect(history.every((h) => typeof h.at === 'string')).toBe(true);
      // Attribué à l'identifiant, jamais au nom affiché.
      expect(ledgerAppend).toHaveBeenCalledWith('RECOURS_OUVERT', created.id, 'id-op1', expect.any(String));
      expect(ledgerAppend).toHaveBeenCalledWith('RECOURS_TRANSITION', created.id, 'id-agent.saa', expect.stringContaining('"onBehalfOf":"SAA"'));
    });

    it('un rôle place ne peut pas accepter ni opposer au nom de la débitrice (403)', async () => {
      const created = await service.create({ claimId: 'clm-subst', from: 'CAAT', to: 'SAA', amount: 10 });
      for (const action of ['accepter', 'opposer']) {
        await expect(service.transition(created.id, { action }, placeUser())).rejects.toMatchObject({ status: 403 });
      }
      expect((await service.get(created.id)).state).toBe('EN_ATTENTE');
    });

    it('l’historique d’audit est réservé aux rôles place (404 pour une compagnie, même partie)', async () => {
      const created = await service.create({ claimId: 'clm-hist', from: 'CAAT', to: 'SAA', amount: 10 });
      await expect(service.history(created.id, correspondant('CAAT'))).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('SEC-46 — hors périmètre, réponse identique à un recours inexistant', () => {
    it('getForUser : un tiers reçoit le même 404 qu’un id inconnu', async () => {
      const created = await service.create({ claimId: 'clm-46', from: 'CAAT', to: 'SAA', amount: 10 });
      const outside = await service.getForUser(created.id, correspondant('CASH')).catch((e) => e);
      const missing = await service.getForUser('00000000-0000-4000-8000-000000000000', correspondant('CASH')).catch((e) => e);
      expect(outside.getStatus()).toBe(404);
      expect(outside.getResponse()).toEqual(missing.getResponse());
    });

    it('transition par un tiers : 404 générique, jamais les codes des parties', async () => {
      const created = await service.create({ claimId: 'clm-46b', from: 'CAAT', to: 'SAA', amount: 10 });
      const err = await service.transition(created.id, { action: 'accepter' }, correspondant('CASH')).catch((e) => e);
      expect(err.getStatus()).toBe(404);
      expect(JSON.stringify(err.getResponse())).not.toMatch(/CAAT|SAA/);
    });

    it('transition par la mauvaise partie : 403 sans code de compagnie dans le message', async () => {
      const created = await service.create({ claimId: 'clm-46c', from: 'CAAT', to: 'SAA', amount: 10 });
      const err = await service.transition(created.id, { action: 'accepter' }, correspondant('CAAT')).catch((e) => e);
      expect(err.getStatus()).toBe(403);
      expect(JSON.stringify(err.getResponse())).not.toMatch(/CAAT|SAA/);
    });
  });

  describe('SEC-33 — transitions concurrentes', () => {
    it('acceptation et opposition simultanées : l’une réussit, l’autre reçoit 409, sans écrasement', async () => {
      const created = await service.create({ claimId: 'clm-33', from: 'CAAT', to: 'SAA', amount: 10 });
      const saa = correspondant('SAA');
      const results = await Promise.allSettled([service.transition(created.id, { action: 'accepter' }, saa), service.transition(created.id, { action: 'opposer' }, saa)]);
      const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ state: string }>[];
      const ko = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(ko).toHaveLength(1);
      expect(ko[0].reason.getStatus()).toBe(409);
      expect((await service.get(created.id)).state).toBe(ok[0].value.state);
    });
  });

  describe('SEC-32 — la clôture en commission exige une décision prononcée au PV signé', () => {
    async function toCommission(claimId: string) {
      const r = await service.create({ claimId, from: 'CAAT', to: 'SAA', amount: 10 });
      await service.transition(r.id, { action: 'opposer' }, correspondant('SAA'));
      await service.transition(r.id, { action: 'contester' }, correspondant('CAAT'));
      await service.transition(r.id, { action: 'transmettre_commission' }, correspondant('CAAT'));
      return r.id;
    }

    it('refuse (409 DECISION_COMMISSION_REQUISE) sans dossier de commission', async () => {
      const id = await toCommission('clm-32a');
      await expect(service.transition(id, { action: 'cloturer_commission_favorable' }, placeUser())).rejects.toMatchObject({ status: 409, response: { code: 'DECISION_COMMISSION_REQUISE' } });
    });

    it('refuse une décision non signée ou de sens contraire, accepte une décision prononcée au PV signé', async () => {
      const id = await toCommission('clm-32b');
      let decision: CommissionDecisionForRecours = { caseId: 'case-1', status: 'PRONONCE', outcome: 'RECOURS_FONDE', pvSigned: false };
      service.registerCommissionDecisionLookup(async () => decision);
      await expect(service.transition(id, { action: 'cloturer_commission_favorable' }, placeUser())).rejects.toMatchObject({ status: 409 });
      decision = { ...decision, pvSigned: true, pvRef: 'PV-case-1' };
      await expect(service.transition(id, { action: 'cloturer_commission_defavorable' }, placeUser())).rejects.toMatchObject({ status: 409 });
      const res = await service.transition(id, { action: 'cloturer_commission_favorable' }, placeUser());
      expect(res.state).toBe('REGLE');
      const history = await service.history(id, placeUser());
      expect(history[history.length - 1]).toMatchObject({ action: 'cloturer_commission_favorable', commissionCaseId: 'case-1', pvRef: 'PV-case-1' });
    });

    it('la note de clôture cite la référence métier du dossier de commission, pas son id technique', async () => {
      const id = await toCommission('clm-32d');
      service.registerCommissionDecisionLookup(async () => ({ caseId: 'uuid-technique', caseReference: 'CSC-2026-013', status: 'PRONONCE', outcome: 'RECOURS_FONDE', pvSigned: true, pvRef: 'PV-CSC-2026-013' }));
      await service.transition(id, { action: 'cloturer_commission_favorable', reason: 'Recours fondé' }, placeUser());
      const after = await service.getForUser(id, placeUser());
      expect(after.resolution?.note).toBe('Recours fondé — Dossier CSC-2026-013 — PV PV-CSC-2026-013');
    });

    it('un rôle compagnie ne clôture jamais en commission (403), même avec le privilège decide', async () => {
      const id = await toCommission('clm-32c');
      await expect(service.transition(id, { action: 'cloturer_commission_favorable' }, { ...correspondant('CAAT'), privileges: ['decide'] })).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('SEC-35 — échéances appliquées par la tâche périodique, datées de l’échéance', () => {
    it('sweep() règle tacitement un recours échu, settledAt = échéance Art.10', async () => {
      const created = await service.create({ claimId: 'clm-35', from: 'CAAT', to: 'SAA', amount: 10 });
      const sentAt = new Date(created.requestSentAt).getTime();
      await service.sweep(new Date(sentAt + 45 * 86_400_000));
      const after = (await service.listAll()).find((r) => r.id === created.id)!;
      expect(after.state).toBe('REGLE');
      expect(after.settledAt).toBe(new Date(sentAt + 30 * 86_400_000).toISOString());
      expect(ledgerAppend).toHaveBeenCalledWith('RECOURS_TRANSITION', created.id, 'system', expect.stringContaining('ACCEPTATION_TACITE_ART10'));
    });
  });

  it('transition invalide (action non autorisée dans l’état courant) renvoie un 400 normalisé, jamais un faux 404', async () => {
    const created = await service.create({ claimId: 'clm-3', from: 'CAAT', to: 'SAA', amount: 30_000 });
    await expect(service.transition(created.id, { action: 'contester' }, correspondant('CAAT'))).rejects.toMatchObject({ response: { code: 'INVALID_TRANSITION' } });
  });

  it('transition sur un id inconnu renvoie un 404 normalisé', async () => {
    await expect(service.transition('inconnu', { action: 'accepter' }, correspondant('SAA'))).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });

  it('opposer puis contester puis transmettre_commission : parcours complet jusqu’en commission', async () => {
    const created = await service.create({ claimId: 'clm-4', from: 'CAAT', to: 'SAA', amount: 120_000 });
    await service.transition(created.id, { action: 'opposer', reason: 'Montant contesté' }, correspondant('SAA'));
    let detail = await service.get(created.id);
    expect(detail.state).toBe('OPPOSITION');
    expect(detail.opposition?.status).toBe('EN_COURS');
    expect(detail.timer.timerType).toBe('OPPOSITION_ART12');

    await service.transition(created.id, { action: 'contester', reason: 'Désaccord sur le motif' }, correspondant('CAAT'));
    expect((await service.get(created.id)).state).toBe('CONTESTATION');

    await service.transition(created.id, { action: 'transmettre_commission' }, placeUser());
    detail = await service.get(created.id);
    expect(detail.state).toBe('COMMISSION');
    expect(detail.commissionAt).toBeDefined();
  });

  it('counters() dénombre correctement par état', async () => {
    const a = await service.create({ claimId: 'clm-6', from: 'CAAT', to: 'SAA', amount: 1000 });
    await service.create({ claimId: 'clm-7', from: 'SAA', to: 'CASH', amount: 2000 });
    await service.transition(a.id, { action: 'accepter' }, correspondant('SAA'));

    const counters = await service.counters();
    expect(counters).toMatchObject({ TOUS: 2, REGLE: 1, EN_ATTENTE: 1 });
  });

  it('utilise RECOURS_SILENCE_DAYS/RECOURS_OPPOSITION_DAYS/ELIGIBILITY_RECOURS_MAX_MONTHS si fournis (paramétrable)', async () => {
    const custom = await buildService({ RECOURS_SILENCE_DAYS: '5', RECOURS_OPPOSITION_DAYS: '3', ELIGIBILITY_RECOURS_MAX_MONTHS: '1' });
    expect(custom.getTimerConfig()).toEqual({ silenceDays: 5, oppositionDays: 3, forclusionMonths: 1 });
  });

  it('SEC-48 : un délai invalide fait échouer la construction du service (démarrage refusé)', async () => {
    await expect(buildService({ RECOURS_SILENCE_DAYS: 'abc' })).rejects.toThrow(/Configuration invalide/);
    await expect(buildService({ RECOURS_OPPOSITION_DAYS: '-3' })).rejects.toThrow(/Configuration invalide/);
    await expect(buildService({ ELIGIBILITY_MAX_AMOUNT_DA: 'Infinity' })).rejects.toThrow(/Configuration invalide/);
  });
});

describe('RecoursService — motif d’opposition (reasonCode, décision PO §1)', () => {
  let service: RecoursService;

  beforeEach(async () => {
    // Repositories du référentiel : base injoignable pour toute méthode (findAll, findOneOrFail, persistAndFlush…).
    const failing = () => simulatedOutageEntityManager();
    const convention = new ConventionReferentialService(failing() as never, failing() as never, failing() as never);
    await convention.createMotif({ code: 'MONTANT_CONTESTE', label: 'Montant contesté' }, placeUser('op'));
    await convention.createMotif({ code: 'EN_ATTENTE_UAR', label: 'Motif non encore validé' }, placeUser('op'));
    await convention.validateMotif('MONTANT_CONTESTE', placeUser('uar'));
    const moduleRef = await Test.createTestingModule({
      providers: [
        RecoursService,
        { provide: getRepositoryToken(Recours), useFactory: throwingRepo },
        { provide: ConfigService, useFactory: () => fakeConfigService() },
        { provide: RealtimeGateway, useValue: { emitEvent: jest.fn() } },
        { provide: AdherentsService, useValue: { assertOppositionMotifUsable: (code: string) => convention.assertOppositionMotifUsable(code) } },
      ],
    }).compile();
    service = moduleRef.get(RecoursService);
  });

  it('stocke le reasonCode d’un motif admis dans l’opposition', async () => {
    const created = await service.create({ claimId: 'clm-rc-1', from: 'CAAT', to: 'SAA', amount: 10_000 });
    await service.transition(created.id, { action: 'opposer', reason: 'Montant excessif', reasonCode: 'MONTANT_CONTESTE' }, correspondant('SAA'));
    const detail = await service.get(created.id);
    expect(detail.opposition).toMatchObject({ reason: 'Montant excessif', reasonCode: 'MONTANT_CONTESTE', status: 'EN_COURS' });
  });

  it('refuse (400, Art. 10) le motif interdit « non-déclaration », sans changer l’état du recours', async () => {
    const created = await service.create({ claimId: 'clm-rc-2', from: 'CAAT', to: 'SAA', amount: 10_000 });
    const err = await service.transition(created.id, { action: 'opposer', reasonCode: 'NON_DECLARATION' }, correspondant('SAA')).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(err.response).toMatchObject({ code: 'MOTIF_INTERDIT', message: expect.stringMatching(/Art\. 10/) });
    expect((await service.get(created.id)).state).toBe('EN_ATTENTE');
  });

  it('refuse (400) un motif saisi mais pas encore validé UAR, sans changer l’état du recours', async () => {
    const created = await service.create({ claimId: 'clm-rc-6', from: 'CAAT', to: 'SAA', amount: 10_000 });
    await expect(service.transition(created.id, { action: 'opposer', reasonCode: 'EN_ATTENTE_UAR' }, correspondant('SAA'))).rejects.toMatchObject({ response: { code: 'MOTIF_NON_VALIDE' } });
    expect((await service.get(created.id)).state).toBe('EN_ATTENTE');
  });

  it('refuse (400) un motif absent du catalogue', async () => {
    const created = await service.create({ claimId: 'clm-rc-3', from: 'CAAT', to: 'SAA', amount: 10_000 });
    await expect(service.transition(created.id, { action: 'opposer', reasonCode: 'INVENTE' }, correspondant('SAA'))).rejects.toMatchObject({ response: { code: 'MOTIF_INCONNU' } });
  });

  it('refuse (400) un reasonCode sur une autre action qu’« opposer »', async () => {
    const created = await service.create({ claimId: 'clm-rc-4', from: 'CAAT', to: 'SAA', amount: 10_000 });
    await expect(service.transition(created.id, { action: 'accepter', reasonCode: 'MONTANT_CONTESTE' }, correspondant('SAA'))).rejects.toMatchObject({ response: { code: 'BAD_REQUEST' } });
  });

  it('sans reasonCode, opposer se comporte comme avant (aucun champ ajouté)', async () => {
    const created = await service.create({ claimId: 'clm-rc-5', from: 'CAAT', to: 'SAA', amount: 10_000 });
    await service.transition(created.id, { action: 'opposer', reason: 'Libre' }, correspondant('SAA'));
    const detail = await service.get(created.id);
    expect(detail.opposition).not.toHaveProperty('reasonCode');
    expect(detail.opposition?.reason).toBe('Libre');
  });
});
