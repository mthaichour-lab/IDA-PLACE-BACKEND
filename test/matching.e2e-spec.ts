import { INestApplication } from '@nestjs/common';
import * as path from 'path';
import request from 'supertest';
import { createTestApp } from './utils/test-app';

/**
 * Confrontation & matching (écran 2) e2e — B.5. Couvre le scénario complet
 * du sprint : import de 2 déclarations partageant le même n° e-constat
 * (compagnies croisées CAAT/SAA) → appariement automatique (score 100,
 * level AUTO, status AUTO_CONFIRME) → décisions confirm/reject → PERSISTANCE
 * vérifiée par un GET /matching/queue suivant (régression du bug
 * class-validator corrigé ce sprint sur `MatchDecisionDto`, voir
 * HANDOFF.md backend).
 */
describe('Confrontation & matching — /api/v1/matching/* (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    // Importe un accident avec 2 déclarations partageant le même e-constat
    // (compagnies croisées) pour peupler la file de confrontation.
    await request(app.getHttpServer())
      .post('/api/v1/claims/import')
      .query({ company: 'CAAT' })
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .attach('file', path.join(__dirname, 'fixtures/import-matching-shared-econstat.csv'))
      .expect(201);
    // SEC-02 : chaque compagnie importe sa propre déclaration (la ligne de l'autre est refusée).
    await request(app.getHttpServer())
      .post('/api/v1/claims/import')
      .query({ company: 'SAA' })
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .attach('file', path.join(__dirname, 'fixtures/import-matching-shared-econstat.csv'))
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /matching/thresholds renvoie les seuils par défaut (80/50, B.5)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/matching/thresholds')
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .expect(200);
    expect(res.body).toMatchObject({ autoThreshold: 80, confirmThreshold: 50 });
  });

  it('un même n° e-constat produit un score 100, econstatShared=true, level AUTO, status AUTO_CONFIRME', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/matching/queue')
      .query({ filter: 'AUTO' })
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .expect(200);

    const matches = res.body.items.filter((m: { refA: string }) => m.refA === 'ECN-E2E-MATCH-01');
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (const m of matches) {
      expect(m.score).toBe(100);
      expect(m.econstatShared).toBe(true);
      expect(m.level).toBe('AUTO');
      expect(m.status).toBe('AUTO_CONFIRME');
      expect(m.criteria).toMatchObject({
        econstatPartage: true,
        plaquesCroisees: true,
        policeCroisee: true,
        dateHeure: true,
        compagniesCroisees: true,
      });
    }
  });

  it('rejette un filtre de file invalide (enum MATCH_FILTERS) avec 400', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/matching/queue')
      .query({ filter: 'invalide' })
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .expect(400);
  });

  describe('decide() — persistance réelle (régression bug class-validator MatchDecisionDto)', () => {
    async function firstQueueItemId(): Promise<string> {
      const res = await request(app.getHttpServer())
        .get('/api/v1/matching/queue')
        .query({ filter: 'AUTO' })
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(200);
      const match = res.body.items.find((m: { refA: string }) => m.refA === 'ECN-E2E-MATCH-01');
      expect(match).toBeDefined();
      return match.id;
    }

    it('rejette une action hors énumération MATCH_DECISIONS avec 400 (DTO validé)', async () => {
      const id = await firstQueueItemId();
      await request(app.getHttpServer())
        .post(`/api/v1/matching/${id}/decide`)
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ action: 'hack-the-planet' })
        .expect(400);
    });

    it('confirm : persiste status=CONFIRME_MANUEL + confirmedBy/confirmedAt, visible au GET suivant', async () => {
      const id = await firstQueueItemId();

      const decideRes = await request(app.getHttpServer())
        .post(`/api/v1/matching/${id}/decide`)
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ action: 'confirm' })
        .expect(201);
      expect(decideRes.body).toMatchObject({ id, status: 'CONFIRME_MANUEL' });
      expect(decideRes.body.decidedBy).toEqual(expect.any(String));

      // Le bug corrigé ce sprint faisait disparaître `status`/`rejectReason`
      // du GET suivant (ValidationPipe whitelist effaçait silencieusement
      // les champs non décorés de MatchDecisionDto). On vérifie ici la
      // PERSISTANCE réelle, pas seulement la réponse du POST.
      const queueRes = await request(app.getHttpServer())
        .get('/api/v1/matching/queue')
        .query({ filter: 'TOUS' })
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(200);
      const persisted = queueRes.body.items.find((m: { id: string }) => m.id === id);
      expect(persisted).toBeDefined();
      expect(persisted.status).toBe('CONFIRME_MANUEL');
      expect(persisted.confirmedBy).toEqual(expect.any(String));
      expect(persisted.confirmedAt).toEqual(expect.any(String));
    });

    it('reject avec motif : persiste status=REJETE + rejectReason, visible au GET suivant', async () => {
      const id = await firstQueueItemId();

      await request(app.getHttpServer())
        .post(`/api/v1/matching/${id}/decide`)
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ action: 'reject', reason: 'Montants incohérents (test e2e)' })
        .expect(201);

      const queueRes = await request(app.getHttpServer())
        .get('/api/v1/matching/queue')
        .query({ filter: 'TOUS' })
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(200);
      const persisted = queueRes.body.items.find((m: { id: string }) => m.id === id);
      expect(persisted.status).toBe('REJETE');
      expect(persisted.rejectReason).toBe('Montants incohérents (test e2e)');
    });

    it('complement : persiste status=COMPLEMENT, visible au GET suivant', async () => {
      const id = await firstQueueItemId();

      await request(app.getHttpServer())
        .post(`/api/v1/matching/${id}/decide`)
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ action: 'complement', reason: 'Pièces à compléter (re-décision motivée, SEC-28)' })
        .expect(201);

      const queueRes = await request(app.getHttpServer())
        .get('/api/v1/matching/queue')
        .query({ filter: 'TOUS' })
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(200);
      const persisted = queueRes.body.items.find((m: { id: string }) => m.id === id);
      expect(persisted.status).toBe('COMPLEMENT');
    });

    it('une décision humaine terminale (CONFIRME_MANUEL) ne doit pas être recalculée par un nouvel import (Art. 14)', async () => {
      const id = await firstQueueItemId();
      await request(app.getHttpServer())
        .post(`/api/v1/matching/${id}/decide`)
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ action: 'confirm', reason: 'Confirmation après complément (SEC-28)' })
        .expect(201);

      // Nouvel import (ré-ingestion) qui recalcule l'appariement.
      await request(app.getHttpServer())
        .post('/api/v1/claims/import')
        .query({ company: 'CAAT' })
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', path.join(__dirname, 'fixtures/import-matching-shared-econstat.csv'))
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/claims/import')
        .query({ company: 'SAA' })
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', path.join(__dirname, 'fixtures/import-matching-shared-econstat.csv'))
        .expect(201);

      const queueRes = await request(app.getHttpServer())
        .get('/api/v1/matching/queue')
        .query({ filter: 'TOUS' })
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(200);
      const persisted = queueRes.body.items.find((m: { id: string }) => m.id === id);
      // Toujours tranché manuellement, pas écrasé par le recalcul automatique.
      expect(persisted.status).toBe('CONFIRME_MANUEL');
    });

    it('404 normalisé sur un id de confrontation inconnu', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/matching/does-not-exist/decide')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ action: 'confirm' })
        .expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it("AUDITEUR_CSA ne peut jamais décider (403), même avec une action valide", async () => {
      const id = await firstQueueItemId();
      await request(app.getHttpServer())
        .post(`/api/v1/matching/${id}/decide`)
        .set('x-dev-user', 'AUDITEUR_CSA')
        .send({ action: 'confirm' })
        .expect(403);
    });

    it('ne fuite jamais les champs internes declAId/declBId dans la réponse HTTP (repli mémoire)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/matching/queue')
        .query({ filter: 'TOUS' })
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(200);
      for (const item of res.body.items) {
        expect(item).not.toHaveProperty('declAId');
        expect(item).not.toHaveProperty('declBId');
      }
    });
  });
});
