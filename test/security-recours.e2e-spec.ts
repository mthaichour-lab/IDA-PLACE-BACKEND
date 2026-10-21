import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PLACE_ROOM, RealtimeGateway, tenantRoom } from '../src/realtime/realtime.module';
import { importEligibleClaim } from './utils/claims';
import { createTestApp } from './utils/test-app';

/**
 * Revue sécurité 2026-10-19 — périmètre « recours, compensation, commission,
 * référentiel » (plan de remédiation IDA Place). Chaque test reproduit le
 * scénario d'exploitation du constat cité, contre l'application démarrée
 * (mode dégradé, comme `npm run start:dev` dans cet environnement).
 */
describe('Revue sécurité 2026-10-19 — recours, compensation, commission, référentiel (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  /** Utilisateur arbitraire (rôle, compagnie, identifiant). */
  function as(role: string, id: string, companyId?: string, extra: Record<string, unknown> = {}) {
    return JSON.stringify({ id, name: id, email: `${id}@test.dz`, role, ...(companyId ? { companyId } : {}), ...extra });
  }
  const corr = (company: string) => as('CORRESPONDANT_IDA', `corr-${company.toLowerCase()}`, company);
  const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';

  async function openRecours(econstat: string, from: string, to: string, amount = 10_000): Promise<string> {
    const claimId = await importEligibleClaim(app, econstat, from, to);
    const res = await http().post('/api/v1/recours').set('x-dev-user', 'OPERATEUR_PLACE').send({ claimId, from, to, amount }).expect(201);
    return res.body.id;
  }
  const transition = (id: string, action: string, user: string, extra: Record<string, unknown> = {}) =>
    http().post(`/api/v1/recours/${id}/transition`).set('x-dev-user', user).send({ action, ...extra });

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('SEC-06 — montant d’un recours borné', () => {
    it('refuse un montant supérieur au montant du dossier (400), 1e308 et 3 décimales (400)', async () => {
      const claimId = await importEligibleClaim(app, 'E2E-S06-1', 'CAAT', 'SAA'); // dossier de 150 000 DA
      const over = await http().post('/api/v1/recours').set('x-dev-user', 'OPERATEUR_PLACE').send({ claimId, from: 'CAAT', to: 'SAA', amount: 150_000.01 }).expect(400);
      expect(over.body.code).toBe('RECOURS_MONTANT_SUPERIEUR_DOSSIER');
      await http().post('/api/v1/recours').set('x-dev-user', 'OPERATEUR_PLACE').send({ claimId, from: 'CAAT', to: 'SAA', amount: 1e308 }).expect(400);
      await http().post('/api/v1/recours').set('x-dev-user', 'OPERATEUR_PLACE').send({ claimId, from: 'CAAT', to: 'SAA', amount: 100.123 }).expect(400);
      await http().post('/api/v1/recours').set('x-dev-user', 'OPERATEUR_PLACE').send({ claimId, from: 'CAAT', to: 'SAA', amount: null }).expect(400);
      await http().post('/api/v1/recours').set('x-dev-user', 'OPERATEUR_PLACE').send({ claimId, from: 'CAAT', to: 'SAA', amount: 1_000_000_000_000 }).expect(400);
      const ok = await http().post('/api/v1/recours').set('x-dev-user', 'OPERATEUR_PLACE').send({ claimId, from: 'CAAT', to: 'SAA', amount: 150_000 }).expect(201);
      expect(ok.body.amount).toBe(150_000);
    });
  });

  describe('SEC-20 — un seul recours par dossier', () => {
    it('deux ouvertures concurrentes sur le même dossier : une seule réussit, l’autre reçoit 409', async () => {
      const claimId = await importEligibleClaim(app, 'E2E-S20-1', 'CAAT', 'SAA');
      const send = () => http().post('/api/v1/recours').set('x-dev-user', 'OPERATEUR_PLACE').send({ claimId, from: 'CAAT', to: 'SAA', amount: 1_000 });
      const [a, b] = await Promise.all([send(), send()]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect((a.status === 409 ? a : b).body.code).toBe('RECOURS_EXISTANT');
    });
  });

  describe('SEC-07 — temps réel limité aux parties, payload minimal', () => {
    it('une transition n’est diffusée qu’à la place et aux deux compagnies parties, avec { id, reference, state } seulement', async () => {
      const id = await openRecours('E2E-S07-1', 'CAAT', 'SAA');
      const gateway = app.get(RealtimeGateway);
      const emitted: Array<{ rooms: unknown; event: string; payload: unknown }> = [];
      const spy = jest.spyOn(gateway.server, 'to').mockImplementation(((rooms: unknown) => ({ emit: (event: string, payload: unknown) => emitted.push({ rooms, event, payload }) })) as never);
      try {
        await transition(id, 'opposer', corr('SAA'), { reason: 'Montant' }).expect(201);
      } finally {
        spy.mockRestore();
      }
      const recoursEvents = emitted.filter((e) => e.event === 'recours.timer');
      expect(recoursEvents).toEqual([{ rooms: [PLACE_ROOM, tenantRoom('CAAT'), tenantRoom('SAA')], event: 'recours.timer', payload: { id, reference: expect.stringMatching(/^REC-\d{4}-\d{5,}$/), state: 'OPPOSITION' } }]);
    });
  });

  describe('SEC-46 / SEC-44 — 404 uniforme hors périmètre, identifiants validés', () => {
    it('un tiers reçoit pour un recours existant exactement la même réponse que pour un id inconnu', async () => {
      const id = await openRecours('E2E-S46-1', 'CAAT', 'SAA');
      const existing = await http().get(`/api/v1/recours/${id}`).set('x-dev-user', corr('CASH')).expect(404);
      const unknown = await http().get(`/api/v1/recours/${UNKNOWN_UUID}`).set('x-dev-user', corr('CASH')).expect(404);
      expect(existing.body).toEqual(unknown.body);
      const t1 = await transition(id, 'accepter', corr('CASH')).expect(404);
      const t2 = await transition(UNKNOWN_UUID, 'accepter', corr('CASH')).expect(404);
      expect(t1.body).toEqual(t2.body);
      expect(JSON.stringify(t1.body)).not.toMatch(/CAAT|SAA/);
    });

    it('un identifiant mal formé est refusé (400) avant tout accès', async () => {
      await http().get('/api/v1/recours/pas-un-uuid').set('x-dev-user', 'OPERATEUR_PLACE').expect(400);
      await http().get('/api/v1/commission/cases/pas-un-uuid').set('x-dev-user', 'OPERATEUR_PLACE').expect(400);
      await http().put('/api/v1/referential/companies/pas-un-uuid').set('x-dev-user', 'OPERATEUR_PLACE').send({ name: 'x' }).expect(400);
    });

    it('?companyId[$ne]=X n’atteint jamais le filtre ORM ; un companyId mal formé est refusé (400)', async () => {
      const companies = await http().get('/api/v1/referential/companies').query({ pageSize: 100 }).set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      const caat = companies.body.items.find((c: { code: string }) => c.code === 'CAAT');
      // L'opérateur injecté n'atteint jamais le service : clé de requête non déclarée → 400 (intercepteur strict global, phase 2).
      const injected = await http().get('/api/v1/referential/agencies').query(`companyId[$ne]=${caat.id}&pageSize=100`).set('x-dev-user', corr('CAAT')).expect(400);
      expect(injected.body.code).toBe('PARAMETRE_INCONNU');
      // Sans opérateur, un rôle compagnie ne reçoit que SES agences.
      const own = await http().get('/api/v1/referential/agencies').query({ pageSize: 100 }).set('x-dev-user', corr('CAAT')).expect(200);
      expect(own.body.items.every((a: { companyId: string }) => a.companyId === caat.id)).toBe(true);
      await http().get('/api/v1/referential/agencies').query({ companyId: 'pas-un-uuid' }).set('x-dev-user', 'OPERATEUR_PLACE').expect(400);
      await http().get('/api/v1/recours').query({ pageSize: 500 }).set('x-dev-user', 'OPERATEUR_PLACE').expect(400);
    });
  });

  describe('SEC-17 — acteur et preuve', () => {
    it('un rôle place ne peut pas accepter au nom de la débitrice (403) ; l’historique d’audit trace l’auteur réel', async () => {
      const id = await openRecours('E2E-S17-1', 'CAAT', 'SAA');
      await transition(id, 'accepter', 'OPERATEUR_PLACE').expect(403);
      await transition(id, 'opposer', corr('SAA'), { reason: 'Montant excessif' }).expect(201);

      const history = await http().get(`/api/v1/recours/${id}/history`).set('x-dev-user', 'ADMIN_UAR').expect(200);
      expect(history.body[history.body.length - 1]).toMatchObject({
        action: 'opposer',
        actorId: 'corr-saa',
        actorRole: 'CORRESPONDANT_IDA',
        onBehalfOf: 'SAA',
        reason: 'Montant excessif',
      });
      await http().get(`/api/v1/recours/${id}/history`).set('x-dev-user', corr('SAA')).expect(404);
      // La fiche elle-même n'expose ni l'historique ni la version, à la création comme en lecture.
      const claimId = await importEligibleClaim(app, 'E2E-S17-2', 'CAAT', 'SAA');
      const created = await http().post('/api/v1/recours').set('x-dev-user', corr('CAAT')).send({ claimId, from: 'CAAT', to: 'SAA', amount: 1_000 }).expect(201);
      const read = await http().get(`/api/v1/recours/${id}`).set('x-dev-user', corr('SAA')).expect(200);
      for (const body of [created.body, read.body]) {
        expect(body).not.toHaveProperty('history');
        expect(body).not.toHaveProperty('version');
      }
    });
  });

  describe('SEC-33 — transitions concurrentes', () => {
    it('acceptation et opposition simultanées : l’une réussit, l’autre reçoit 409', async () => {
      const id = await openRecours('E2E-S33-1', 'CAAT', 'SAA');
      const [a, b] = await Promise.all([transition(id, 'accepter', corr('SAA')), transition(id, 'opposer', corr('SAA'))]);
      // Jamais deux succès : l'une réussit, l'autre est refusée (409 si elle a lu l'état avant l'écriture, 400 sinon).
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(201);
      expect([400, 409]).toContain(statuses[1]);
      const winner = a.status === 201 ? a : b;
      const detail = await http().get(`/api/v1/recours/${id}`).set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      expect(detail.body.state).toBe(winner.body.state);
    });
  });

  describe('SEC-32 / SEC-25 — commission collégiale, PV non réécrivable, clôture liée au PV', () => {
    const member = (id: string) => as('MEMBRE_COMMISSION', id);

    it('parcours complet, contrôles de collégialité et clôture du recours conditionnée au PV signé', async () => {
      const id = await openRecours('E2E-S32-1', 'CAAT', 'SAA', 20_000);
      // Saisie impossible tant que le recours n'est pas en commission.
      await http().post('/api/v1/commission/cases').set('x-dev-user', corr('CAAT')).send({ recoursId: id, motif: 'x' }).expect(409);
      await transition(id, 'opposer', corr('SAA')).expect(201);
      await transition(id, 'contester', corr('CAAT')).expect(201);
      await transition(id, 'transmettre_commission', corr('CAAT')).expect(201);

      // Clôture refusée sans décision de commission.
      await transition(id, 'cloturer_commission_favorable', member('m-a')).expect(409);

      const kase = await http().post('/api/v1/commission/cases').set('x-dev-user', corr('CAAT')).send({ recoursId: id, motif: 'Litige' }).expect(201);
      await http().post('/api/v1/commission/cases').set('x-dev-user', corr('CAAT')).send({ recoursId: id, motif: 'Bis' }).expect(409);
      const caseId = kase.body.id;

      // SEC-25 : un correspondant porteur du privilège `decide` par dérogation reste refusé.
      await http().post(`/api/v1/commission/cases/${caseId}/deliberate`).set('x-dev-user', as('CORRESPONDANT_IDA', 'corr-grant', 'CASH', { grant: ['decide'] })).expect(403);

      await http().post(`/api/v1/commission/cases/${caseId}/deliberate`).set('x-dev-user', member('m-a')).expect(201);
      await http().post(`/api/v1/commission/cases/${caseId}/penalty`).set('x-dev-user', member('m-a')).send({ companyCode: 'SAA', amount: 1000, reason: 'x' }).expect(409);
      await http().post(`/api/v1/commission/cases/${caseId}/decide`).set('x-dev-user', member('m-a')).send({ outcome: 'RECOURS_FONDE' }).expect(201);

      // PV : jamais par l'auteur du prononcé, jamais deux fois, référence serveur (une `ref` cliente est ignorée).
      await http().post(`/api/v1/commission/cases/${caseId}/pv-sign`).set('x-dev-user', member('m-a')).send({}).expect(409);
      const pv = await http().post(`/api/v1/commission/cases/${caseId}/pv-sign`).set('x-dev-user', member('m-b')).send({ ref: 'PV-ANTIDATE' }).expect(201);
      expect(pv.body.pv.ref).toBe(`PV-${caseId}`);
      await http().post(`/api/v1/commission/cases/${caseId}/pv-sign`).set('x-dev-user', member('m-c')).send({}).expect(409);

      // Sanction : proposée, puis contresignée par un autre membre.
      const proposed = await http().post(`/api/v1/commission/cases/${caseId}/sanction`).set('x-dev-user', member('m-a')).send({ companyCode: 'SAA', type: 'AVERTISSEMENT', reason: 'Retards' }).expect(201);
      expect(proposed.body.status).toBe('A_CONTRESIGNER');
      await http().post(`/api/v1/commission/sanctions/${proposed.body.id}/countersign`).set('x-dev-user', member('m-a')).expect(409);
      const countersigned = await http().post(`/api/v1/commission/sanctions/${proposed.body.id}/countersign`).set('x-dev-user', member('m-b')).expect(201);
      expect(countersigned.body.status).toBe('PRONONCEE');

      // Clôture : le sens doit correspondre à la décision.
      await transition(id, 'cloturer_commission_defavorable', member('m-a')).expect(409);
      const closed = await transition(id, 'cloturer_commission_favorable', member('m-a')).expect(201);
      expect(closed.body.state).toBe('REGLE');
    });
  });

  describe('SEC-19 / SEC-26 — clôtures', () => {
    it('un trimestre non échu ne se clôture pas (409) ; l’auteur d’une clôture n’est pas exposé aux compagnies', async () => {
      await http().post('/api/v1/settlement/quarter/2099-Q1/close').set('x-dev-user', 'OPERATEUR_PLACE').expect(409);
      for (const step of ['SAISIE', 'SYNTHESE_ANNEXE_7', 'TRANSMISSION_ANNEXE_8', 'SYNTHESE_GLOBALE_REUNION']) {
        await http().post(`/api/v1/settlement/quarter/2021-Q1/pipeline/${step}/complete`).set('x-dev-user', 'OPERATEUR_PLACE').send({ note: 'Note interne' }).expect(201);
      }
      await http().post('/api/v1/settlement/quarter/2021-Q1/close').set('x-dev-user', 'OPERATEUR_PLACE').expect(201);
      await http().post('/api/v1/settlement/quarter/2021-Q1/close').set('x-dev-user', 'OPERATEUR_PLACE').expect(409);

      const forCompany = await http().get('/api/v1/settlement/quarter/closures').set('x-dev-user', corr('CAAT')).expect(200);
      const q = forCompany.body.find((c: { period: string }) => c.period === '2021-Q1');
      expect(q).toBeDefined();
      expect(q).not.toHaveProperty('closedBy');
      const forPlace = await http().get('/api/v1/settlement/quarter/closures').set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      expect(forPlace.body.find((c: { period: string }) => c.period === '2021-Q1')).toHaveProperty('closedBy');

      const pipeline = await http().get('/api/v1/settlement/quarter/2021-Q1/pipeline').set('x-dev-user', corr('CAAT')).expect(200);
      expect(pipeline.body.steps[0]).not.toHaveProperty('completedBy');
      expect(pipeline.body.steps[0]).not.toHaveProperty('note');
    });

    it('la note d’une étape est bornée (400 au-delà de 500 caractères)', async () => {
      await http().post('/api/v1/settlement/quarter/2021-Q2/pipeline/SAISIE/complete').set('x-dev-user', 'OPERATEUR_PLACE').send({ note: 'x'.repeat(501) }).expect(400);
    });
  });

  describe('SEC-04 — gouvernance d’une compagnie', () => {
    it('un correspondant ne peut ni se réactiver ni allonger ses délais (403) ; le changement passe par deux Admin UAR', async () => {
      const startedAt = new Date(Date.now() - 1000).toISOString();
      const created = await http().post('/api/v1/referential/companies').set('x-dev-user', 'OPERATEUR_PLACE').send({ code: 'GOVE', name: 'Gouvernance E2E', color: '#445566', kind: 'INSURER', feedMode: 'API' }).expect(201);
      const companyId = created.body.id;
      for (const body of [{ status: 'ACTIF' }, { delayOverrides: { recoursDays: 999 } }, { kind: 'MUTUAL' }, { feedMode: 'ERP' }]) {
        const res = await http().put(`/api/v1/referential/companies/${companyId}`).set('x-dev-user', corr('GOVE')).send(body).expect(403);
        expect(res.body.code).toBe('GOUVERNANCE_RESERVEE');
      }
      // Profil : toujours modifiable par le correspondant de SA compagnie.
      await http().put(`/api/v1/referential/companies/${companyId}`).set('x-dev-user', corr('GOVE')).send({ correspondentPhone: '021 00 00 00' }).expect(200);

      const uar = (id: string) => as('ADMIN_UAR', id);
      await http().post(`/api/v1/referential/companies/${companyId}/governance-changes`).set('x-dev-user', 'OPERATEUR_PLACE').send({ status: 'SUSPENDU', reason: 'x' }).expect(403);
      const change = await http().post(`/api/v1/referential/companies/${companyId}/governance-changes`).set('x-dev-user', uar('uar-1')).send({ status: 'SUSPENDU', reason: 'Décision commission' }).expect(201);
      expect((await http().get(`/api/v1/referential/companies/${companyId}`).set('x-dev-user', 'OPERATEUR_PLACE')).body.status).toBe('ACTIF');
      await http().post(`/api/v1/referential/companies/${companyId}/governance-changes/${change.body.id}/validate`).set('x-dev-user', uar('uar-1')).expect(409);
      await http().post(`/api/v1/referential/companies/${companyId}/governance-changes/${change.body.id}/validate`).set('x-dev-user', uar('uar-2')).expect(201);
      expect((await http().get(`/api/v1/referential/companies/${companyId}`).set('x-dev-user', 'OPERATEUR_PLACE')).body.status).toBe('SUSPENDU');

      // Journal paginé : on parcourt les pages des entrées écrites depuis le début du test.
      const entries: Array<{ type: string; ref: string; actor: string; summary: string }> = [];
      for (let page = 1; page <= 20; page++) {
        const ledger = await http().get('/api/v1/ledger').query({ page, pageSize: 100, from: startedAt }).set('x-dev-user', 'ADMIN_UAR').expect(200);
        const items = Array.isArray(ledger.body) ? ledger.body : ledger.body.items;
        entries.push(...items);
        if (items.length < 100) break;
      }
      const sealed = entries.find((e) => e.type === 'COMPANY_GOUVERNANCE' && e.ref === 'GOVE');
      expect(sealed).toMatchObject({ actor: 'uar-2' });
      expect(sealed!.summary).toMatch(/"requestedBy":"uar-1"/);
    });

    it('SEC-44 : un code compagnie de 3 lettres (comme SAA) est accepté, un code hors format refusé', async () => {
      await http().post('/api/v1/referential/companies').set('x-dev-user', 'OPERATEUR_PLACE').send({ code: 'GAM', name: 'GAM Assurances', color: '#445566', kind: 'INSURER', feedMode: 'API' }).expect(201);
      for (const code of ['TOOLONG', 'ab', 'A', 'A$B']) {
        await http().post('/api/v1/referential/companies').set('x-dev-user', 'OPERATEUR_PLACE').send({ code, name: 'x', color: '#445566', kind: 'INSURER', feedMode: 'API' }).expect(400);
      }
    });
  });

  describe('SEC-14 / SEC-26 / SEC-31 — référentiel partagé', () => {
    it('une compagnie ne modifie pas le statut d’un expert partagé ni le rattachement d’une concurrente (403)', async () => {
      const expert = await http().post('/api/v1/referential/experts').set('x-dev-user', 'OPERATEUR_PLACE').send({ name: 'Expert partagé', companies: ['CAAT', 'SAA'] }).expect(201);
      await http().put(`/api/v1/referential/experts/${expert.body.id}`).set('x-dev-user', corr('CAAT')).send({ status: 'SUSPENDU' }).expect(403);
      await http().put(`/api/v1/referential/experts/${expert.body.id}`).set('x-dev-user', corr('CAAT')).send({ companies: ['CAAT'] }).expect(403);
      await http().put(`/api/v1/referential/experts/${expert.body.id}`).set('x-dev-user', corr('CAAT')).send({ companies: ['SAA'] }).expect(200); // retire son propre rattachement
    });

    it('une compagnie ne lit que ses agences et ses experts, et la projection publique des concurrentes', async () => {
      const companies = await http().get('/api/v1/referential/companies').query({ pageSize: 100 }).set('x-dev-user', corr('CAAT')).expect(200);
      const saa = companies.body.items.find((c: { code: string }) => c.code === 'SAA');
      const caat = companies.body.items.find((c: { code: string }) => c.code === 'CAAT');
      expect(saa).not.toHaveProperty('agencyCounts');
      expect(saa).not.toHaveProperty('apiKeyMasked');
      expect(caat).toHaveProperty('agencyCounts');

      const agencies = await http().get('/api/v1/referential/agencies').query({ companyId: saa.id, pageSize: 100 }).set('x-dev-user', corr('CAAT')).expect(200);
      expect(agencies.body.items).toEqual([]);
      const own = await http().get('/api/v1/referential/agencies').query({ pageSize: 100 }).set('x-dev-user', corr('CAAT')).expect(200);
      expect(own.body.items.every((a: { companyId: string }) => a.companyId === caat.id)).toBe(true);

      const experts = await http().get('/api/v1/referential/experts').query({ pageSize: 100 }).set('x-dev-user', corr('CASH')).expect(200);
      expect(experts.body.items.every((e: { companies: string[] }) => e.companies.length === 1 && e.companies[0] === 'CASH')).toBe(true);
    });

    it('une agence ne peut pas être rattachée à une agence d’une autre compagnie (400)', async () => {
      const companies = await http().get('/api/v1/referential/companies').query({ pageSize: 100 }).set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      const caat = companies.body.items.find((c: { code: string }) => c.code === 'CAAT');
      const saa = companies.body.items.find((c: { code: string }) => c.code === 'SAA');
      const saaAgencies = await http().get('/api/v1/referential/agencies').query({ companyId: saa.id }).set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      const res = await http()
        .post('/api/v1/referential/agencies')
        .set('x-dev-user', corr('CAAT'))
        .send({ companyId: caat.id, code: 'AG-E2E-31', name: 'Agence pirate', type: 'AG', parentId: saaAgencies.body.items[0].id })
        .expect(400);
      expect(res.body.code).toBe('PARENT_INVALIDE');
    });
  });

  describe('SEC-47 / SEC-30 — adhésions et référentiels conventionnels', () => {
    it('une demande de retrait antidatée au-delà du plafond, ou sans référence de courrier, est refusée (400)', async () => {
      const companies = await http().get('/api/v1/referential/companies').query({ pageSize: 100 }).set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      const alli = companies.body.items.find((c: { code: string }) => c.code === 'ALLI');
      const old = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
      const recent = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
      const tooOld = await http().post('/api/v1/commission/membership-requests').set('x-dev-user', 'OPERATEUR_PLACE').send({ type: 'RETRAIT', receivedAt: old, companyId: alli.id, letterRef: 'L-1' }).expect(400);
      expect(tooOld.body.code).toBe('DATE_RECEPTION_TROP_ANCIENNE');
      await http().post('/api/v1/commission/membership-requests').set('x-dev-user', 'OPERATEUR_PLACE').send({ type: 'RETRAIT', receivedAt: recent, companyId: alli.id }).expect(400);
    });

    it('un férié mobile ne peut pas être confirmé par son auteur (409 FOUR_EYES)', async () => {
      const created = await http().post('/api/v1/referential/mobile-holidays').set('x-dev-user', 'OPERATEUR_PLACE').send({ date: '2028-05-05', kind: 'AID_EL_ADHA' }).expect(201);
      const res = await http().post(`/api/v1/referential/mobile-holidays/${created.body.id}/confirm`).set('x-dev-user', 'OPERATEUR_PLACE').send({ sourceRef: 'Communiqué' }).expect(409);
      expect(res.body.code).toBe('FOUR_EYES');
    });
  });
});
