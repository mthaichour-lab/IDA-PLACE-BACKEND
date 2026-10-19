import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { importEligibleClaim } from './utils/claims';
import { createTestApp } from './utils/test-app';

/**
 * Référentiels de place (écran 12) — décisions PO points 1 à 4 : fériés
 * mobiles, circonstances du constat, motifs d'opposition, populations,
 * référence IRSAM. Sans PostgreSQL (repli mémoire), comme l'application
 * démarrée dans cet environnement.
 */
describe('Référentiels de place — points 1 à 4 (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const IRSAM_BODY = {
    indicator: 'DELAI_MOYEN_REGLEMENT_RECOURS_JOURS',
    value: 74,
    periodFrom: '2025-01-01',
    periodTo: '2025-12-31',
    measureDefinition: { startEvent: 'Envoi de la demande de recours', endEvent: 'Règlement inter-compagnies', scope: 'Recours matériels E-Recours' },
    sourceRef: 'E-Recours e2e',
  };

  describe('CORRESPONDANT_IDA : 403 en écriture sur chaque nouveau référentiel', () => {
    it.each([
      ['post', '/api/v1/referential/mobile-holidays', { date: '2026-03-20', kind: 'AID_EL_FITR' }],
      ['put', '/api/v1/referential/mobile-holidays/any', { hijriYear: 1447 }],
      ['post', '/api/v1/referential/mobile-holidays/any/confirm', { sourceRef: 'x' }],
      ['delete', '/api/v1/referential/mobile-holidays/any', undefined],
      ['put', '/api/v1/referential/constat-circumstances/1', { labelAr: 'x' }],
      ['post', '/api/v1/referential/constat-circumstances/1/validate', {}],
      ['post', '/api/v1/referential/opposition-motifs', { code: 'E2E_CORR', label: 'x' }],
      ['put', '/api/v1/referential/opposition-motifs/NON_DECLARATION', { label: 'x' }],
      ['post', '/api/v1/referential/opposition-motifs/NON_DECLARATION/validate', {}],
      ['put', '/api/v1/referential/wilayas/49', { effectiveFrom: '2019-12-18' }],
      ['post', '/api/v1/referential/wilaya-populations', { wilayaCode: '16', referenceYear: 2024, population: 1, sourceType: 'AUTRE', sourceRef: 'x' }],
      ['put', '/api/v1/referential/wilaya-populations/any', { population: 2 }],
      ['post', '/api/v1/referential/irsam-benchmarks', IRSAM_BODY],
      ['post', '/api/v1/referential/irsam-benchmarks/any/validate', {}],
      ['post', '/api/v1/referential/irsam-benchmarks/any/archive', {}],
    ])('%s %s → 403', async (method, url, body) => {
      const req = (http() as unknown as Record<string, (u: string) => request.Test>)[method](url).set('x-dev-user', 'CORRESPONDANT_IDA');
      const res = await (body === undefined ? req : req.send(body));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('POST /referential/wilaya-populations/import → 403', async () => {
      const res = await http()
        .post('/api/v1/referential/wilaya-populations/import')
        .set('x-dev-user', 'CORRESPONDANT_IDA')
        .attach('file', Buffer.from('16;2024;1;AUTRE;x\n'), 'pop.csv');
      expect(res.status).toBe(403);
    });

    it('lecture ouverte à tous les profils (AUDITEUR_CSA)', async () => {
      for (const url of ['mobile-holidays', 'mobile-holiday-kinds', 'constat-circumstances', 'opposition-motifs', 'wilaya-populations', 'irsam-benchmarks']) {
        await http().get(`/api/v1/referential/${url}`).set('x-dev-user', 'AUDITEUR_CSA').expect(200);
      }
    });
  });

  describe('validateRef réservé à ADMIN_UAR, règle des quatre yeux', () => {
    it.each([
      '/api/v1/referential/constat-circumstances/2/validate',
      '/api/v1/referential/opposition-motifs/NON_DECLARATION/validate',
      '/api/v1/referential/irsam-benchmarks/any/validate',
    ])('OPERATEUR_PLACE ne peut pas valider : POST %s → 403', async (url) => {
      const res = await http().post(url).set('x-dev-user', 'OPERATEUR_PLACE').send({});
      expect(res.status).toBe(403);
      expect(res.body.details.required).toEqual(['validateRef']);
    });

    it('ADMIN_UAR auteur d’un motif ne peut pas le valider (409), un motif saisi par l’opérateur oui', async () => {
      await http().post('/api/v1/referential/opposition-motifs').set('x-dev-user', 'ADMIN_UAR').send({ code: 'E2E_4Y_ADMIN', label: 'Motif e2e admin' }).expect(201);
      const conflict = await http().post('/api/v1/referential/opposition-motifs/E2E_4Y_ADMIN/validate').set('x-dev-user', 'ADMIN_UAR').send({});
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('FOUR_EYES');

      await http().post('/api/v1/referential/opposition-motifs').set('x-dev-user', 'OPERATEUR_PLACE').send({ code: 'E2E_4Y_OP', label: 'Motif e2e opérateur' }).expect(201);
      const ok = await http().post('/api/v1/referential/opposition-motifs/E2E_4Y_OP/validate').set('x-dev-user', 'ADMIN_UAR').send({}).expect(201);
      expect(ok.body).toMatchObject({ status: 'VALIDE_UAR', validatedBy: 'dev-admin-uar', createdBy: 'dev-op' });
    });

    it('ADMIN_UAR valide une circonstance pré-remplie (auteur system:seed)', async () => {
      const res = await http().post('/api/v1/referential/constat-circumstances/17/validate').set('x-dev-user', 'ADMIN_UAR').send({}).expect(201);
      expect(res.body).toMatchObject({ number: 17, status: 'VALIDE_UAR' });
    });
  });

  describe('fériés mobiles et calendrier (§2)', () => {
    it('GET /referential/calendar?from&to : union fixes + mobiles avec statut, champs existants conservés', async () => {
      const created = await http()
        .post('/api/v1/referential/mobile-holidays')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ date: '2027-01-12', kind: 'AWAL_MOHARRAM', hijriYear: 1448 })
        .expect(201);
      expect(created.body.status).toBe('PREVISIONNEL');

      const res = await http().get('/api/v1/referential/calendar').query({ from: '2027-01-01', to: '2027-01-31' }).set('x-dev-user', 'AUDITEUR_CSA').expect(200);
      expect(res.body.weekendDays).toEqual(['FRIDAY', 'SATURDAY']);
      expect(res.body.fixedHolidays.length).toBeGreaterThan(0);
      expect(res.body.holidays).toEqual([
        { date: '2027-01-01', label: "Jour de l'an", type: 'FIXE', status: 'LEGAL' },
        { date: '2027-01-12', label: 'Yennayer', type: 'FIXE', status: 'LEGAL' },
        { date: '2027-01-12', label: 'Awal Moharram', type: 'MOBILE', kind: 'AWAL_MOHARRAM', status: 'PREVISIONNEL' },
      ]);

      await http().post(`/api/v1/referential/mobile-holidays/${created.body.id}/confirm`).set('x-dev-user', 'ADMIN_UAR').send({}).expect(400);
      // SEC-30 : confirmée par une autre personne que l'auteur de la saisie (quatre yeux).
      const confirmed = await http()
        .post(`/api/v1/referential/mobile-holidays/${created.body.id}/confirm`)
        .set('x-dev-user', 'ADMIN_UAR')
        .send({ sourceRef: 'Communiqué e2e' })
        .expect(201);
      expect(confirmed.body).toMatchObject({ status: 'CONFIRME', sourceRef: 'Communiqué e2e' });
    });

    it('400 sur une date de calendrier invalide', async () => {
      await http().get('/api/v1/referential/calendar').query({ from: '2027-13-01' }).set('x-dev-user', 'OPERATEUR_PLACE').expect(400);
    });
  });

  describe('motif d’opposition sur un recours (§1)', () => {
    it('opposer avec le motif interdit « non-déclaration » → 400 citant l’Art. 10', async () => {
      const claimId = await importEligibleClaim(app, 'E2E-REF-MOTIF', 'CAAT', 'SAA');
      const recours = await http()
        .post('/api/v1/recours')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ claimId, from: 'CAAT', to: 'SAA', amount: 10_000 })
        .expect(201);
      const res = await http()
        .post(`/api/v1/recours/${recours.body.id}/transition`)
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ action: 'opposer', reasonCode: 'NON_DECLARATION' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MOTIF_INTERDIT');
      expect(res.body.message).toMatch(/Art\. 10/);
    });
  });

  describe('populations et per100k (§3)', () => {
    it('per100k est null partout sans population, puis calculé une fois une population saisie', async () => {
      const before = await http().get('/api/v1/stats/wilayas').set('x-dev-user', 'AUDITEUR_CSA').expect(200);
      expect(before.body).toHaveLength(69);
      expect(before.body.every((w: { per100k: unknown }) => w.per100k === null)).toBe(true);

      const report = await http()
        .post('/api/v1/referential/wilaya-populations/import')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', Buffer.from('code;annee;population;source_type;source_ref\n58;2024;100000;ESTIMATION_ONS;ONS e2e\n'), 'pop.csv')
        .expect(201);
      expect(report.body).toMatchObject({ acceptedCount: 1, rejectedCount: 0, written: true });

      const after = await http().get('/api/v1/stats/wilayas').query({ year: 2026 }).set('x-dev-user', 'AUDITEUR_CSA').expect(200);
      const w58 = after.body.find((w: { code: string }) => w.code === '58');
      expect(w58.per100k).toEqual(expect.any(Number));
      expect(w58.populationRef).toMatchObject({ referenceYear: 2024, sourceRef: 'ONS e2e' });
    });

    it('import avec une ligne rejetée : rien n’est écrit', async () => {
      const report = await http()
        .post('/api/v1/referential/wilaya-populations/import')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', Buffer.from('57;2024;100000;ESTIMATION_ONS;ONS e2e\n57;2025;abc;ESTIMATION_ONS;ONS e2e\n'), 'pop.csv')
        .expect(201);
      expect(report.body).toMatchObject({ acceptedCount: 1, rejectedCount: 1, written: false, writtenCount: 0 });
      const list = await http().get('/api/v1/referential/wilaya-populations').query({ wilayaCode: '57' }).set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      expect(list.body).toEqual([]);
    });
  });

  describe('comparatif IRSAM (§4)', () => {
    it('irsam reste null tant que la référence n’est pas validée UAR', async () => {
      const initial = await http().get('/api/v1/stats/summary').set('x-dev-user', 'AUDITEUR_CSA').expect(200);
      expect(initial.body).toMatchObject({ irsam: null, irsamStatus: 'NON_RENSEIGNE' });
      expect(initial.body).toHaveProperty('avgSettlementDays');

      const created = await http().post('/api/v1/referential/irsam-benchmarks').set('x-dev-user', 'OPERATEUR_PLACE').send(IRSAM_BODY).expect(201);
      const pending = await http().get('/api/v1/stats/summary').set('x-dev-user', 'AUDITEUR_CSA').expect(200);
      expect(pending.body).toMatchObject({ irsam: null, irsamStatus: 'EN_ATTENTE_VALIDATION' });

      await http().post(`/api/v1/referential/irsam-benchmarks/${created.body.id}/validate`).set('x-dev-user', 'ADMIN_UAR').send({}).expect(201);
      const validated = await http().get('/api/v1/stats/summary').set('x-dev-user', 'AUDITEUR_CSA').expect(200);
      expect(validated.body.irsamStatus).toBe('VALIDE');
      expect(validated.body.irsam).toMatchObject({ value: 74, periodFrom: '2025-01-01', periodTo: '2025-12-31', sourceRef: 'E-Recours e2e' });
    });

    it('400 si la définition de mesure manque', async () => {
      const { measureDefinition: _omit, ...withoutMeasure } = IRSAM_BODY;
      void _omit;
      await http().post('/api/v1/referential/irsam-benchmarks').set('x-dev-user', 'OPERATEUR_PLACE').send(withoutMeasure).expect(400);
    });
  });
});
