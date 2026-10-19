import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { importEligibleClaim } from './utils/claims';
import { createTestApp } from './utils/test-app';

/**
 * Revue sécurité 2026-10-18 (B.7) — régression e2e des failles de scoping
 * tenant trouvées lors de l'audit RBAC systématique de ce round (voir
 * HANDOFF.md/ARCHITECTURE.md pour le détail par module). Chaque test
 * reproduit le scénario d'exploitation exact décrit dans le rapport
 * d'audit, avant/après correctif.
 */
describe('Revue sécurité (B.7) — régression des failles de scoping tenant trouvées 2026-10-18', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Simule un utilisateur scopé compagnie avec un companyId arbitraire (les demo users de DevAuthProvider sont tous fixés sur "CAAT"). */
  function companyUser(role: 'CORRESPONDANT_IDA' | 'TRESORIER', companyId: string) {
    return JSON.stringify({ id: `u-${companyId}`, name: `${role} ${companyId}`, email: `u@${companyId}.test`, role, companyId });
  }

  describe('DocumentsModule — upload/presign (B.10)', () => {
    it("upload préfixe la clé par la compagnie de l'appelant, pas un \"default-tenant\" partagé", async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .attach('file', Buffer.from('contenu test'), 'constat.pdf')
        .expect(201);
      expect(res.body.key).toMatch(/^CAAT\//);
    });

    it('upload par un rôle place préfixe la clé par "place"', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', Buffer.from('contenu test'), 'pv.pdf')
        .expect(201);
      expect(res.body.key).toMatch(/^place\//);
    });

    it('AUDITEUR_CSA (lecture seule) ne peut pas uploader — 403', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', 'AUDITEUR_CSA')
        .attach('file', Buffer.from('x'), 'x.pdf')
        .expect(403);
    });

    it("presign refuse avec un 403 qu'une compagnie obtienne l'URL d'un document d'une AUTRE compagnie", async () => {
      const upload = await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .attach('file', Buffer.from('x'), 'x.pdf')
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/documents/presign/${encodeURIComponent(upload.body.key)}`)
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'SAA'))
        .expect(403);
    });

    it("presign autorise la compagnie propriétaire du document", async () => {
      const upload = await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .attach('file', Buffer.from('x'), 'x.pdf')
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/documents/presign/${encodeURIComponent(upload.body.key)}`)
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .expect(200);
    });

    it('presign autorise un document "place" à tout utilisateur authentifié (aucune compagnie propriétaire)', async () => {
      const upload = await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', Buffer.from('x'), 'x.pdf')
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/documents/presign/${encodeURIComponent(upload.body.key)}`)
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'SAA'))
        .expect(200);
    });
  });

  describe('AdminModule — GET /admin/users (B.7)', () => {
    it("refuse avec un 403 qu'un CORRESPONDANT_IDA liste les utilisateurs de la place", async () => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/users')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .expect(403);
    });

    it('autorise un rôle place (OPERATEUR_PLACE)', async () => {
      await request(app.getHttpServer()).get('/api/v1/admin/users').set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
    });
  });

  describe('RecoursModule — POST /recours (B.7, usurpation de from)', () => {
    it("refuse avec un 403 qu'un CORRESPONDANT_IDA crée un recours au nom d'une AUTRE compagnie (dto.from)", async () => {
      await request(app.getHttpServer())
        .post('/api/v1/recours')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .send({ claimId: 'clm-usurp', from: 'SAA', to: 'CAAR', amount: 10_000 })
        .expect(403);
    });

    it('refuse un dossier inexistant (404), un dossier d’une autre compagnie (400), une mauvaise partie tierce (400) et un second recours (409)', async () => {
      const server = () => request(app.getHttpServer());
      await server()
        .post('/api/v1/recours')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .send({ claimId: 'clm-inexistant', from: 'CAAT', to: 'SAA', amount: 10_000 })
        .expect(404);

      const saaClaim = await importEligibleClaim(app, 'E2E-SEC-SAA-OWN', 'SAA', 'CAAT');
      const notDirect = await server().post('/api/v1/recours').set('x-dev-user', 'OPERATEUR_PLACE').send({ claimId: saaClaim, from: 'CAAT', to: 'SAA', amount: 10_000 }).expect(400);
      expect(notDirect.body.code).toBe('RECOURS_HORS_ASSUREUR_DIRECT');

      const caatClaim = await importEligibleClaim(app, 'E2E-SEC-UNIQUE', 'CAAT', 'SAA');
      const wrongParty = await server().post('/api/v1/recours').set('x-dev-user', 'OPERATEUR_PLACE').send({ claimId: caatClaim, from: 'CAAT', to: 'CASH', amount: 10_000 }).expect(400);
      expect(wrongParty.body.code).toBe('RECOURS_MAUVAISE_PARTIE');

      await server().post('/api/v1/recours').set('x-dev-user', 'OPERATEUR_PLACE').send({ claimId: caatClaim, from: 'CAAT', to: 'SAA', amount: 10_000 }).expect(201);
      const duplicate = await server().post('/api/v1/recours').set('x-dev-user', 'OPERATEUR_PLACE').send({ claimId: caatClaim, from: 'CAAT', to: 'SAA', amount: 10_000 }).expect(409);
      expect(duplicate.body.code).toBe('RECOURS_EXISTANT');
    });

    it('autorise un CORRESPONDANT_IDA à créer un recours en son propre nom (dto.from = sa compagnie)', async () => {
      const claimId = await importEligibleClaim(app, 'E2E-SEC-LEGIT', 'CAAT', 'CASH');
      await request(app.getHttpServer())
        .post('/api/v1/recours')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .send({ claimId, from: 'CAAT', to: 'CASH', amount: 10_000 })
        .expect(201);
    });
  });

  describe('CommissionModule — POST /commission/cases (B.7, fuite via recours tiers)', () => {
    it("refuse avec un 403 qu'une compagnie ouvre un dossier de commission à partir d'un recours auquel elle n'est PAS partie", async () => {
      const claimId = await importEligibleClaim(app, 'E2E-SEC-COM-FOREIGN', 'SAA', 'CASH');
      const recours = await request(app.getHttpServer())
        .post('/api/v1/recours')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ claimId, from: 'SAA', to: 'CASH', amount: 50_000 })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/commission/cases')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .send({ recoursId: recours.body.id, motif: 'Tentative illégitime' })
        .expect(403);
    });

    it('autorise une compagnie partie au recours à ouvrir le dossier de commission', async () => {
      const claimId = await importEligibleClaim(app, 'E2E-SEC-COM-LEGIT', 'CAAT', 'CASH');
      const recours = await request(app.getHttpServer())
        .post('/api/v1/recours')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ claimId, from: 'CAAT', to: 'CASH', amount: 50_000 })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/commission/cases')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .send({ recoursId: recours.body.id, motif: 'Litige légitime' })
        .expect(201);
    });
  });

  describe('MeteringModule — GET /metering/:company/:period (B.7)', () => {
    it("refuse avec un 403 qu'une compagnie consulte la facturation d'une AUTRE compagnie", async () => {
      await request(app.getHttpServer())
        .get('/api/v1/metering/SAA/2026-09')
        .set('x-dev-user', companyUser('TRESORIER', 'CAAT'))
        .expect(403);
    });

    it('autorise une compagnie à consulter SA PROPRE facturation', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/metering/CAAT/2026-09')
        .set('x-dev-user', companyUser('TRESORIER', 'CAAT'))
        .expect(200);
    });
  });

  describe('MonitoringModule — GET /monitoring/companies/:code/journeys (B.7)', () => {
    it("refuse avec un 403 qu'une compagnie consulte le parcours dossier d'une AUTRE compagnie", async () => {
      await request(app.getHttpServer())
        .get('/api/v1/monitoring/companies/SAA/journeys')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .expect(403);
    });

    it('autorise une compagnie à consulter SON PROPRE parcours dossier', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/monitoring/companies/CAAT/journeys')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .expect(200);
    });

    it('scores() reste place-wide (classement documenté, dossier technique §Détail par écran 8) — accessible à une compagnie', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/monitoring/scores')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .expect(200);
      expect(res.body).toHaveProperty('companies');
    });
  });

  describe('FraudModule — GET /fraud/adherents/:company/signals (B.7)', () => {
    it("refuse avec un 403 qu'une compagnie consulte les signaux de fraude d'une AUTRE compagnie", async () => {
      await request(app.getHttpServer())
        .get('/api/v1/fraud/adherents/SAA/signals')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .expect(403);
    });

    it('autorise une compagnie à consulter SES PROPRES signaux de fraude', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/fraud/adherents/CAAT/signals')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .expect(200);
    });
  });

  describe('SettlementModule — POST /settlement/monthly/:period/close (B.7)', () => {
    it("refuse avec un 403 qu'un TRESORIER clôture la synthèse mensuelle d'une AUTRE compagnie", async () => {
      await request(app.getHttpServer())
        .post('/api/v1/settlement/monthly/2026-01/close')
        .set('x-dev-user', companyUser('TRESORIER', 'CAAT'))
        .send({ company: 'SAA' })
        .expect(403);
    });
  });

  /**
   * QUESTIONS_UAR.md §9, décision Product Owner 2026-10-18 — extension de
   * DocumentsModule aux pièces jointes de Recours/CommissionCase :
   * `GET /documents?recoursId=X` doit réutiliser EXACTEMENT le même
   * contrôle de périmètre compagnie que `RecoursService.get` (voir
   * `DocumentsService.listForDossier`, documents.module.ts).
   */
  describe('DocumentsModule — GET /documents?recoursId=X (QUESTIONS_UAR.md §9)', () => {
    it("refuse avec un 403 qu'un CORRESPONDANT_IDA liste les documents d'un recours auquel sa compagnie n'est PAS partie", async () => {
      const claimId = await importEligibleClaim(app, 'E2E-SEC-DOCS-FOREIGN', 'SAA', 'CASH');
      const recours = await request(app.getHttpServer())
        .post('/api/v1/recours')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ claimId, from: 'SAA', to: 'CASH', amount: 25_000 })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'SAA'))
        .field('recoursId', recours.body.id)
        .attach('file', Buffer.from('piece'), 'annexe2.pdf')
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/documents?recoursId=${recours.body.id}`)
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .expect(403);
    });

    it('autorise une compagnie partie au recours à lister les documents de SON dossier', async () => {
      const claimId = await importEligibleClaim(app, 'E2E-SEC-DOCS-LEGIT', 'CAAT', 'CASH');
      const recours = await request(app.getHttpServer())
        .post('/api/v1/recours')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ claimId, from: 'CAAT', to: 'CASH', amount: 25_000 })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .field('recoursId', recours.body.id)
        .attach('file', Buffer.from('piece'), 'annexe2.pdf')
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/documents?recoursId=${recours.body.id}`)
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      expect(res.body[0]).toMatchObject({ filename: 'annexe2.pdf', uploadedBy: expect.any(String), url: expect.any(String) });
    });

    it("renvoie un 404 si le recours cité n'existe pas", async () => {
      await request(app.getHttpServer())
        .get('/api/v1/documents?recoursId=introuvable-xyz')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(404);
    });

    it('renvoie un 400 si ni recoursId ni commissionCaseId ne sont fournis', async () => {
      await request(app.getHttpServer()).get('/api/v1/documents').set('x-dev-user', 'OPERATEUR_PLACE').expect(400);
    });
  });

  /**
   * QUESTIONS_UAR.md §11, décision Product Owner 2026-10-18 — la clôture
   * trimestrielle (place-entière, irréversible) est désormais réservée au
   * privilège dédié `closeQuarter` (OPERATEUR_PLACE/ADMIN_UAR/
   * MEMBRE_COMMISSION), plus `synth` (que CORRESPONDANT_IDA/TRESORIER
   * gardent pour la LECTURE des synthèses).
   */
  describe('SettlementModule — POST /settlement/quarter/:q/close (QUESTIONS_UAR.md §11)', () => {
    it("refuse avec un 403 qu'un TRESORIER clôture la compensation trimestrielle (place-entière)", async () => {
      await request(app.getHttpServer())
        .post('/api/v1/settlement/quarter/2099-Q1/close')
        .set('x-dev-user', companyUser('TRESORIER', 'CAAT'))
        .expect(403);
    });

    it("refuse avec un 403 qu'un CORRESPONDANT_IDA clôture la compensation trimestrielle (place-entière)", async () => {
      await request(app.getHttpServer())
        .post('/api/v1/settlement/quarter/2099-Q1/close')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .expect(403);
    });

    it('refuse (409) la clôture tant que les étapes 1 à 4 de l’avancement du lot ne sont pas réalisées', async () => {
      const res = await request(app.getHttpServer()).post('/api/v1/settlement/quarter/2099-Q4/close').set('x-dev-user', 'OPERATEUR_PLACE').expect(409);
      expect(res.body).toMatchObject({ code: 'PIPELINE_INCOMPLET' });
    });

    it('autorise un OPERATEUR_PLACE à clôturer la compensation trimestrielle une fois les étapes 1 à 4 réalisées', async () => {
      for (const step of ['SAISIE', 'SYNTHESE_ANNEXE_7', 'TRANSMISSION_ANNEXE_8', 'SYNTHESE_GLOBALE_REUNION']) {
        await request(app.getHttpServer()).post(`/api/v1/settlement/quarter/2099-Q2/pipeline/${step}/complete`).set('x-dev-user', 'OPERATEUR_PLACE').send({}).expect(201);
      }
      await request(app.getHttpServer())
        .post('/api/v1/settlement/quarter/2099-Q2/close')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(201);
      const pipeline = await request(app.getHttpServer()).get('/api/v1/settlement/quarter/2099-Q2/pipeline').set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      expect(pipeline.body.steps.every((s: { status: string }) => s.status === 'DONE')).toBe(true);
    });
  });

  /**
   * QUESTIONS_UAR.md §12, décision Product Owner 2026-10-18 — l'onboarding
   * d'une NOUVELLE compagnie adhérente est désormais réservé au privilège
   * dédié `onboardCompany` (OPERATEUR_PLACE/ADMIN_UAR) ; `refedit` reste
   * inchangé pour updateCompany/createAgency/experts.
   */
  describe('AdherentsModule — POST /referential/companies (QUESTIONS_UAR.md §12)', () => {
    it("refuse avec un 403 qu'un CORRESPONDANT_IDA (refedit) onboarde une NOUVELLE compagnie adhérente", async () => {
      await request(app.getHttpServer())
        .post('/api/v1/referential/companies')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .send({ code: 'NEW1', name: 'Nouvelle Compagnie', color: '#445566', kind: 'INSURER', feedMode: 'API' })
        .expect(403);
    });

    it('autorise un OPERATEUR_PLACE à onboarder une NOUVELLE compagnie adhérente', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/referential/companies')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ code: 'NEW2', name: 'Nouvelle Compagnie 2', color: '#445566', kind: 'INSURER', feedMode: 'API' })
        .expect(201);
    });
  });

  /** Adhésions et retraits (Chapitre VI, Art. 30-35) — écriture réservée au privilège `membership`. */
  describe('CommissionModule — /commission/membership-requests', () => {
    it("refuse avec un 403 qu'un CORRESPONDANT_IDA enregistre une demande d'adhésion", async () => {
      await request(app.getHttpServer())
        .post('/api/v1/commission/membership-requests')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .send({ type: 'ADHESION', receivedAt: '2026-01-15', candidateName: 'Candidate E2E' })
        .expect(403);
    });

    it("un CORRESPONDANT_IDA ne voit pas le retrait d'une AUTRE compagnie (403 en fiche, absent de la liste)", async () => {
      const companies = await request(app.getHttpServer())
        .get('/api/v1/referential/companies?pageSize=100')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(200);
      const saa = (companies.body.items as { id: string; code: string }[]).find((c) => c.code === 'SAA');
      expect(saa).toBeDefined();

      const created = await request(app.getHttpServer())
        .post('/api/v1/commission/membership-requests')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ type: 'RETRAIT', receivedAt: '2026-01-15', companyId: saa!.id })
        .expect(201);
      expect(created.body).toMatchObject({ state: 'RECUE', companyCode: 'SAA', effectiveDate: '2026-12-31' });

      try {
        await request(app.getHttpServer())
          .get(`/api/v1/commission/membership-requests/${created.body.id}`)
          .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
          .expect(403);
        const list = await request(app.getHttpServer())
          .get('/api/v1/commission/membership-requests?pageSize=100')
          .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
          .expect(200);
        expect((list.body.items as { id: string }[]).some((r) => r.id === created.body.id)).toBe(false);
        await request(app.getHttpServer())
          .get(`/api/v1/commission/membership-requests/${created.body.id}`)
          .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'SAA'))
          .expect(200);
      } finally {
        await request(app.getHttpServer())
          .post(`/api/v1/commission/membership-requests/${created.body.id}/cancel`)
          .set('x-dev-user', 'OPERATEUR_PLACE')
          .send({ decisionNote: 'Nettoyage e2e' })
          .expect(201);
      }
    });

    /**
     * Audit sécurité 2026-10-19 : une fois le retrait constaté (compagnie
     * EN_RETRAIT), plus aucun NOUVEAU recours ne doit pouvoir être ouvert en
     * son nom pour un sinistre postérieur à la date d'effet. Compagnie
     * jetable (jamais CAAT/SAA, partagées par toute la suite) pour ne pas
     * polluer l'état des autres tests de ce fichier.
     */
    it("un retrait constaté (EN_RETRAIT) bloque l'ouverture d'un nouveau recours pour cette compagnie (403 COMPAGNIE_NON_ACTIVE)", async () => {
      await request(app.getHttpServer())
        .post('/api/v1/referential/companies')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ code: 'WDR1', name: 'Compagnie Retirée E2E', color: '#445566', kind: 'INSURER', feedMode: 'API' })
        .expect(201);

      const claimId = await importEligibleClaim(app, 'E2E-SEC-WITHDRAWN', 'WDR1', 'SAA');
      const companies = await request(app.getHttpServer()).get('/api/v1/referential/companies?pageSize=200').set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      const wd1 = (companies.body.items as { id: string; code: string }[]).find((c) => c.code === 'WDR1');
      expect(wd1).toBeDefined();

      // receivedAt largement passé : la date d'effet (31/12 de l'année de réception, préavis ≥ 3 mois) est déjà révolue.
      const retrait = await request(app.getHttpServer())
        .post('/api/v1/commission/membership-requests')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ type: 'RETRAIT', receivedAt: '2025-01-01', companyId: wd1!.id })
        .expect(201);
      expect(retrait.body.effectiveDate).toBe('2025-12-31');

      await request(app.getHttpServer())
        .post(`/api/v1/commission/membership-requests/${retrait.body.id}/effective`)
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({})
        .expect(201);

      const refused = await request(app.getHttpServer())
        .post('/api/v1/recours')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ claimId, from: 'WDR1', to: 'SAA', amount: 10_000 })
        .expect(403);
      expect(refused.body.code).toBe('COMPAGNIE_NON_ACTIVE');
    });
  });

  /** Avancement du lot trimestriel (Diagramme 2) — pipeline place-entière, privilège `closeQuarter`. */
  describe('SettlementModule — /settlement/quarter/:q/pipeline', () => {
    it("refuse avec un 403 qu'un CORRESPONDANT_IDA fasse avancer le pipeline", async () => {
      await request(app.getHttpServer())
        .post('/api/v1/settlement/quarter/2099-Q3/pipeline/SAISIE/complete')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .send({})
        .expect(403);
    });

    it('un CORRESPONDANT_IDA lit le pipeline ; un OPERATEUR_PLACE le fait avancer dans l’ordre (409 sinon)', async () => {
      const before = await request(app.getHttpServer())
        .get('/api/v1/settlement/quarter/2099-Q3/pipeline')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .expect(200);
      expect(before.body.steps).toHaveLength(5);
      expect(before.body.steps[0]).toMatchObject({ step: 'SAISIE', status: 'EN_COURS' });

      await request(app.getHttpServer())
        .post('/api/v1/settlement/quarter/2099-Q3/pipeline/SYNTHESE_ANNEXE_7/complete')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({})
        .expect(409);
      const after = await request(app.getHttpServer())
        .post('/api/v1/settlement/quarter/2099-Q3/pipeline/SAISIE/complete')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ note: 'e2e' })
        .expect(201);
      expect(after.body.steps[0]).toMatchObject({ status: 'DONE', note: 'e2e' });
    });

    it('GET /settlement/quarter/closures reste routée avant /quarter/:q', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/settlement/quarter/closures').set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});
