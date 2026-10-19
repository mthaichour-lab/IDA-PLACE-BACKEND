import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { LedgerService } from '../ledger/ledger.service';
import { Recours } from '../recours/entities/recours.entity';
import { RecoursService } from '../recours/recours.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import { CommissionService } from './commission.service';
import { CommissionCase } from './entities/commission-case.entity';
import { Sanction } from './entities/sanction.entity';

/** Membre de la place (ex. MEMBRE_COMMISSION). */
function member(name: string): AuthenticatedUser {
  return { id: `id-${name}`, name, email: `${name}@test.local`, role: 'MEMBRE_COMMISSION', privileges: ['decide', 'sanction', 'penaltyOrder', 'pvSign'] };
}

function correspondant(companyId: string): AuthenticatedUser {
  return { id: `c-${companyId}`, name: `corr.${companyId}`, email: 'c@test.local', role: 'CORRESPONDANT_IDA', companyId, privileges: ['exchange'] };
}

/** Repli mémoire forcé — voir recours.service.spec.ts. */
function failingEm(): Record<string, jest.Mock> {
  const fail = () => Promise.reject(new Error('DB injoignable (test)'));
  const em: Record<string, jest.Mock> = { find: jest.fn(fail), findOne: jest.fn(fail), transactional: jest.fn(fail), persistAndFlush: jest.fn(fail), flush: jest.fn(fail) };
  em.fork = jest.fn(() => em);
  return em;
}

function throwingRepo() {
  return {
    create: jest.fn((data: unknown) => data),
    findOne: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    findAll: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    getEntityManager: jest.fn(() => failingEm()),
  };
}

function fakeConfigService(values: Record<string, string> = {}) {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

describe('CommissionService (mode dégradé — file de conciliation, pénalités/sanctions, PV)', () => {
  let commission: CommissionService;
  let recours: RecoursService;
  let ledgerAppend: jest.Mock;
  let seq = 0;

  beforeEach(async () => {
    ledgerAppend = jest.fn(async () => ({}));
    const moduleRef = await Test.createTestingModule({
      providers: [
        CommissionService,
        RecoursService,
        { provide: getRepositoryToken(CommissionCase), useFactory: throwingRepo },
        { provide: getRepositoryToken(Sanction), useFactory: throwingRepo },
        { provide: getRepositoryToken(Recours), useFactory: throwingRepo },
        { provide: ConfigService, useValue: fakeConfigService({ COMMISSION_PENALTY_MAX_DA: '50000' }) },
        { provide: RealtimeGateway, useValue: { emitEvent: jest.fn() } },
        { provide: LedgerService, useValue: { append: ledgerAppend } },
      ],
    }).compile();

    commission = moduleRef.get(CommissionService);
    recours = moduleRef.get(RecoursService);
    commission.onModuleInit();
  });

  async function recoursEnCommission() {
    const r = await recours.create({ claimId: `clm-${++seq}`, from: 'CAAT', to: 'SAA', amount: 75_000 });
    await recours.transition(r.id, { action: 'opposer' }, correspondant('SAA'));
    await recours.transition(r.id, { action: 'contester' }, correspondant('CAAT'));
    await recours.transition(r.id, { action: 'transmettre_commission' }, correspondant('CAAT'));
    return r;
  }

  async function openCase() {
    const r = await recoursEnCommission();
    return commission.createCase({ recoursId: r.id, motif: 'Désaccord sur le montant' }, member('secretaire'));
  }

  /** Dossier PRONONCÉ (auteur : membre A) au PV signé (membre B). */
  async function decidedCase(outcome: 'RECOURS_FONDE' | 'RECOURS_REJETE' = 'RECOURS_FONDE') {
    const kase = await openCase();
    await commission.deliberate(kase.id, member('a'));
    await commission.decide(kase.id, { outcome }, member('a'));
    await commission.pvSign(kase.id, member('b'));
    return kase;
  }

  it('createCase() dénormalise claimId/companyA/companyB/amount depuis le recours et scelle la saisine', async () => {
    const created = await openCase();
    expect(created).toMatchObject({ companyA: 'CAAT', companyB: 'SAA', amount: 75_000, status: 'A_INSTRUIRE' });
    expect(ledgerAppend).toHaveBeenCalledWith('COMMISSION_SAISINE', created.id, 'id-secretaire', expect.any(String));
  });

  it('createCase() renvoie un 404 normalisé si le recours est inconnu', async () => {
    await expect(commission.createCase({ recoursId: 'inconnu', motif: 'x' }, member('m'))).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });

  describe('SEC-32 / SEC-20 — saisine', () => {
    it('refuse un recours qui n’est pas en COMMISSION (409 RECOURS_HORS_COMMISSION)', async () => {
      const r = await recours.create({ claimId: 'clm-pas-commission', from: 'CAAT', to: 'SAA', amount: 10 });
      await expect(commission.createCase({ recoursId: r.id, motif: 'x' }, member('m'))).rejects.toMatchObject({ status: 409, response: { code: 'RECOURS_HORS_COMMISSION' } });
    });

    it('un seul dossier par recours, y compris sous requêtes concurrentes (409)', async () => {
      const r = await recoursEnCommission();
      const results = await Promise.allSettled([
        commission.createCase({ recoursId: r.id, motif: 'a' }, member('m')),
        commission.createCase({ recoursId: r.id, motif: 'b' }, member('m')),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.getResponse()).toMatchObject({ code: 'DOSSIER_COMMISSION_EXISTANT' });
    });

    it('refuse une date de séance dans le passé (400)', async () => {
      const r = await recoursEnCommission();
      await expect(commission.createCase({ recoursId: r.id, motif: 'x', scheduledAt: '2020-01-01T00:00:00Z' }, member('m'))).rejects.toMatchObject({ status: 400 });
    });

    it('SEC-46 : une compagnie non partie reçoit 404 (identique à un recours inexistant)', async () => {
      const r = await recoursEnCommission();
      await expect(commission.createCase({ recoursId: r.id, motif: 'x' }, correspondant('CASH'))).rejects.toMatchObject({ status: 404 });
    });
  });

  it('décider sans avoir délibéré est rejeté (400, jamais un faux 404)', async () => {
    const created = await openCase();
    await expect(commission.decide(created.id, { outcome: 'RECOURS_FONDE' }, member('a'))).rejects.toMatchObject({ response: { code: 'INVALID_TRANSITION' } });
  });

  describe('SEC-25 — actes de commission réservés aux rôles place', () => {
    it('un utilisateur compagnie porteur du privilège (dérogation) est refusé (403) sur délibéré, décision, PV, pénalité, sanction', async () => {
      const kase = await openCase();
      const derogation = { ...correspondant('CASH'), privileges: ['decide', 'sanction', 'penaltyOrder', 'pvSign'] } as AuthenticatedUser;
      await expect(commission.deliberate(kase.id, derogation)).rejects.toMatchObject({ status: 403 });
      await expect(commission.decide(kase.id, { outcome: 'RECOURS_FONDE' }, derogation)).rejects.toMatchObject({ status: 403 });
      await expect(commission.pvSign(kase.id, derogation)).rejects.toMatchObject({ status: 403 });
      await expect(commission.penalty(kase.id, { companyCode: 'SAA', amount: 10, reason: 'x' }, derogation)).rejects.toMatchObject({ status: 403 });
      await expect(commission.sanction(kase.id, { companyCode: 'SAA', type: 'SUSPENSION', reason: 'x' }, derogation)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('SEC-32 — PV', () => {
    it('parcours complet : deliberate -> decide -> pv-sign, référence générée par le serveur et scellée', async () => {
      const created = await openCase();
      expect((await commission.deliberate(created.id, member('a'))).status).toBe('EN_DELIBERE');
      const decided = await commission.decide(created.id, { outcome: 'RECOURS_FONDE', motif: 'Pièces conformes' }, member('a'));
      expect(decided).toMatchObject({ status: 'PRONONCE', decision: { outcome: 'RECOURS_FONDE' } });
      expect(decided.decision).not.toHaveProperty('decidedBy');

      const signed = await commission.pvSign(created.id, member('b'));
      expect(signed.pv).toMatchObject({ signedBy: 'b', ref: `PV-${created.id}` });
      expect(ledgerAppend).toHaveBeenCalledWith('COMMISSION_PV', created.id, 'id-b', expect.stringContaining(`PV-${created.id}`));
    });

    it('un second pvSign est refusé (409 PV_DEJA_SIGNE) : le PV ne se réécrit pas', async () => {
      const kase = await decidedCase();
      await expect(commission.pvSign(kase.id, member('c'))).rejects.toMatchObject({ status: 409, response: { code: 'PV_DEJA_SIGNE' } });
    });

    it('le PV est signé par un autre membre que l’auteur du prononcé (409 FOUR_EYES)', async () => {
      const kase = await openCase();
      await commission.deliberate(kase.id, member('a'));
      await commission.decide(kase.id, { outcome: 'RECOURS_FONDE' }, member('a'));
      await expect(commission.pvSign(kase.id, member('a'))).rejects.toMatchObject({ status: 409, response: { code: 'FOUR_EYES' } });
    });

    it('pv-sign avant le prononcé est rejeté (400)', async () => {
      const created = await openCase();
      await expect(commission.pvSign(created.id, member('b'))).rejects.toMatchObject({ response: { code: 'INVALID_TRANSITION' } });
    });

    it('la clôture du recours en commission suit la décision au PV signé', async () => {
      const kase = await decidedCase('RECOURS_REJETE');
      await expect(recours.transition(kase.recoursId, { action: 'cloturer_commission_favorable' }, member('a'))).rejects.toMatchObject({ status: 409 });
      const res = await recours.transition(kase.recoursId, { action: 'cloturer_commission_defavorable' }, member('a'));
      expect(res.state).toBe('REJETE');
    });
  });

  describe('SEC-32 — pénalités et sanctions', () => {
    it('une sanction sans décision prononcée au PV signé est refusée (409 DECISION_REQUISE)', async () => {
      const kase = await openCase();
      await expect(commission.sanction(kase.id, { companyCode: 'SAA', type: 'SUSPENSION', reason: 'x' }, member('a'))).rejects.toMatchObject({ status: 409, response: { code: 'DECISION_REQUISE' } });
      await commission.deliberate(kase.id, member('a'));
      await commission.decide(kase.id, { outcome: 'RECOURS_FONDE' }, member('a'));
      await expect(commission.penalty(kase.id, { companyCode: 'SAA', amount: 100, reason: 'x' }, member('a'))).rejects.toMatchObject({ response: { code: 'DECISION_REQUISE' } });
    });

    it('penalty() : partie au dossier, montant plafonné, une seule par (dossier, compagnie, type)', async () => {
      const kase = await decidedCase();
      await expect(commission.penalty(kase.id, { companyCode: 'CASH', amount: 1000, reason: 'x' }, member('a'))).rejects.toMatchObject({ response: { code: 'BAD_REQUEST' } });
      await expect(commission.penalty(kase.id, { companyCode: 'SAA', amount: 50_000.01, reason: 'x' }, member('a'))).rejects.toMatchObject({ response: { code: 'PENALITE_PLAFOND' } });
      await expect(commission.penalty(kase.id, { companyCode: 'SAA', amount: Number.NaN, reason: 'x' }, member('a'))).rejects.toMatchObject({ response: { code: 'MONTANT_INVALIDE' } });
      const penalty = await commission.penalty(kase.id, { companyCode: 'SAA', amount: 20_000, reason: 'Retard de traitement' }, member('a'));
      expect(penalty).toMatchObject({ type: 'PENALITE_FINANCIERE', companyCode: 'SAA', status: 'A_CONTRESIGNER' });
      await expect(commission.penalty(kase.id, { companyCode: 'SAA', amount: 1_000, reason: 'Encore' }, member('a'))).rejects.toMatchObject({ status: 409, response: { code: 'SANCTION_EXISTANTE' } });
    });

    it('une sanction n’est prononcée qu’après le contreseing d’un SECOND membre', async () => {
      const kase = await decidedCase();
      const proposed = await commission.sanction(kase.id, { companyCode: 'CAAT', type: 'SUSPENSION', reason: 'Manquements répétés' }, member('a'));
      expect(proposed.status).toBe('A_CONTRESIGNER');
      await expect(commission.countersignSanction(proposed.id, member('a'))).rejects.toMatchObject({ status: 409, response: { code: 'FOUR_EYES' } });
      const done = await commission.countersignSanction(proposed.id, member('b'));
      expect(done).toMatchObject({ status: 'PRONONCEE', countersignedBy: 'b' });
      await expect(commission.countersignSanction(proposed.id, member('c'))).rejects.toMatchObject({ status: 409 });
      expect(ledgerAppend).toHaveBeenCalledWith('SANCTION_PRONONCEE', proposed.id, 'id-b', expect.stringContaining('"proposedBy":"id-a"'));
    });

    it('listSanctions() retrouve la sanction, filtrée par compagnie et statut', async () => {
      const kase = await decidedCase();
      await commission.sanction(kase.id, { companyCode: 'CAAT', type: 'AVERTISSEMENT', reason: 'Qualité de dossier' }, member('a'));
      expect((await commission.listSanctions({ page: 1, pageSize: 6 })).items).toHaveLength(1);
      expect((await commission.listSanctions({ company: 'CAAT', page: 1, pageSize: 6 })).items).toHaveLength(1);
      expect((await commission.listSanctions({ company: 'SAA', page: 1, pageSize: 6 })).items).toHaveLength(0);
      expect((await commission.listSanctions({ status: 'PRONONCEE', page: 1, pageSize: 6 })).items).toHaveLength(0);
    });
  });

  it('listCases()/getCase() reflètent le repli mémoire et filtrent par statut', async () => {
    const created = await openCase();
    await commission.deliberate(created.id, member('a'));
    const list = await commission.listCases({ status: 'EN_DELIBERE', page: 1, pageSize: 6 });
    expect(list.items.map((c) => c.id)).toEqual([created.id]);
    expect((await commission.getCase(created.id)).status).toBe('EN_DELIBERE');
    await expect(commission.getCase('inconnu')).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    await expect(commission.getCaseForUser(created.id, correspondant('CASH'))).rejects.toMatchObject({ status: 404 });
  });

  it('SEC-33 : deux décisions concurrentes sur le même dossier — une seule réussit, l’autre reçoit une erreur (409/400)', async () => {
    const kase = await openCase();
    await commission.deliberate(kase.id, member('a'));
    const results = await Promise.allSettled([
      commission.decide(kase.id, { outcome: 'RECOURS_FONDE' }, member('a')),
      commission.decide(kase.id, { outcome: 'RECOURS_REJETE' }, member('b')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect([400, 409]).toContain((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.getStatus());
  });

  describe('summary() — KPI de synthèse (écran 7, guide illustré)', () => {
    it('compte les dossiers pendants et ceux hors délai Art.24 (15 jours)', async () => {
      const recent = await openCase();
      jest.useFakeTimers().setSystemTime(new Date(Date.now() - 20 * 86_400_000));
      await openCase();
      jest.useRealTimers();

      const summary = await commission.summary();
      expect(summary).toMatchObject({ pendingCount: 2, overdue15dCount: 1 });

      await commission.deliberate(recent.id, member('a'));
      await commission.decide(recent.id, { outcome: 'RECOURS_REJETE' }, member('a'));
      expect((await commission.summary()).pendingCount).toBe(1);
    });

    it('compte les dossiers PRONONCE avec décision RECOURS_FONDE', async () => {
      await decidedCase('RECOURS_FONDE');
      await decidedCase('RECOURS_REJETE');
      expect((await commission.summary()).recoursFondesCount).toBe(1);
    });

    it('compte les oppositions réputées fondées (Art.12) comme une mesure RecoursModule, indépendante des dossiers de commission', async () => {
      const r = await recours.create({ claimId: 'clm-art12', from: 'CAAT', to: 'SAA', amount: 50_000 });
      await recours.transition(r.id, { action: 'opposer' }, correspondant('SAA'));
      jest.useFakeTimers().setSystemTime(new Date(Date.now() + 16 * 86_400_000));
      const summary = await commission.summary();
      jest.useRealTimers();
      expect(summary).toMatchObject({ oppositionsFondeesCount: 1, pendingCount: 0 });
    });
  });
});
