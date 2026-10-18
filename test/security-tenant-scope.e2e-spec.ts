import { INestApplication } from '@nestjs/common';
import request from 'supertest';
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

    it('autorise un CORRESPONDANT_IDA à créer un recours en son propre nom (dto.from = sa compagnie)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/recours')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .send({ claimId: 'clm-legit', from: 'CAAT', to: 'SAA', amount: 10_000 })
        .expect(201);
    });
  });

  describe('CommissionModule — POST /commission/cases (B.7, fuite via recours tiers)', () => {
    it("refuse avec un 403 qu'une compagnie ouvre un dossier de commission à partir d'un recours auquel elle n'est PAS partie", async () => {
      const recours = await request(app.getHttpServer())
        .post('/api/v1/recours')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ claimId: 'clm-commission-foreign', from: 'SAA', to: 'CAAR', amount: 50_000 })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/commission/cases')
        .set('x-dev-user', companyUser('CORRESPONDANT_IDA', 'CAAT'))
        .send({ recoursId: recours.body.id, motif: 'Tentative illégitime' })
        .expect(403);
    });

    it('autorise une compagnie partie au recours à ouvrir le dossier de commission', async () => {
      const recours = await request(app.getHttpServer())
        .post('/api/v1/recours')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ claimId: 'clm-commission-legit', from: 'CAAT', to: 'CAAR', amount: 50_000 })
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
});
