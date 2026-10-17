import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';

/**
 * Référentiel de place (écran 12) e2e — CRUD compagnies/agences/experts,
 * pagination 6/p (A.5), DTO validés (class-validator).
 *
 * Environnement de test SANS PostgreSQL (voir HANDOFF.md backend) : les
 * lectures passent par le repli mémoire (`withDegradedFallback`) — c'est le
 * même mode que l'application réellement démarrée dans cet environnement.
 */
describe('Référentiel de place — /api/v1/referential/* (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Pagination 6/p (A.5)', () => {
    it('GET /referential/companies pagine par défaut à 6 lignes/page', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/referential/companies')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(200);

      expect(res.body).toMatchObject({ page: 1 });
      expect(res.body.items.length).toBeLessThanOrEqual(6);
      expect(res.body.total).toBeGreaterThanOrEqual(res.body.items.length);
    });

    it('respecte un pageSize explicite et pagine correctement sur la page 2', async () => {
      const pageSize = 2;
      const page1 = await request(app.getHttpServer())
        .get('/api/v1/referential/companies')
        .query({ page: 1, pageSize })
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(200);
      const page2 = await request(app.getHttpServer())
        .get('/api/v1/referential/companies')
        .query({ page: 2, pageSize })
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(200);

      expect(page1.body.items.length).toBe(pageSize);
      expect(page1.body.page).toBe(1);
      expect(page2.body.page).toBe(2);
      // Pas de chevauchement entre les deux pages.
      const ids1 = page1.body.items.map((c: { id: string }) => c.id);
      const ids2 = page2.body.items.map((c: { id: string }) => c.id);
      expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
    });
  });

  describe('Companies — vue publique (jamais de clé API en clair)', () => {
    it('ne renvoie jamais apiKey en clair, seulement apiKeyMasked', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/referential/companies')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(200);

      for (const company of res.body.items) {
        expect(company).not.toHaveProperty('apiKeyHash');
        expect(company).not.toHaveProperty('apiKey');
        expect(company.apiKeyMasked).toEqual(expect.any(String));
      }
    });
  });

  describe('DTO validés (class-validator) — POST /referential/companies', () => {
    it('rejette une couleur non hexadécimale avec 400 normalisé', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/referential/companies')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ code: 'TEST', name: 'Test Co', color: 'pas-une-couleur', kind: 'INSURER', feedMode: 'API' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    });

    it('rejette un code compagnie absent (champ requis)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/referential/companies')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ name: 'Sans code', color: '#112233', kind: 'INSURER', feedMode: 'API' });
      expect(res.status).toBe(400);
    });

    it('rejette un "kind" hors de l\'énumération CompanyKind', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/referential/companies')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ code: 'TEST', name: 'Test Co', color: '#112233', kind: 'NOT_A_KIND', feedMode: 'API' });
      expect(res.status).toBe(400);
    });

    /**
     * Régression (voir rapport QA — sévérité majeure, corrigé en revue
     * croisée sprint 3) : contrairement aux lectures (`listCompanies`,
     * `getCompany`, qui utilisent `withDegradedFallback`),
     * `AdherentsService.createCompany`/`updateCompany` (et
     * `ExpertsService.create`/`update`) n'avaient AUCUN repli mémoire — en
     * l'absence de PostgreSQL, l'écriture levait une exception MikroORM non
     * interceptée (`ECONNREFUSED`) renvoyée telle quelle comme 500
     * INTERNAL_ERROR, alors que le principe documenté du mode dégradé
     * (`common/interfaces/degraded-mode.ts`) est "jamais de crash, repli
     * explicite". Les 4 méthodes sont désormais enveloppées dans
     * `withDegradedFallback` comme les lectures — ce test vérifie la
     * non-régression.
     */
    it('POST avec un DTO valide réussit via le repli mémoire (mode dégradé)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/referential/companies')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ code: 'QAT1', name: 'QA Test Co', color: '#112233', kind: 'INSURER', feedMode: 'API' });

      expect(res.status).toBe(201);
      expect(res.body.code).toBe('QAT1');
    });
  });

  describe('Experts — pagination et lecture', () => {
    it('GET /referential/experts pagine 6/p et expose les champs attendus', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/referential/experts')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(200);
      expect(res.body.items.length).toBeLessThanOrEqual(6);
      if (res.body.items.length > 0) {
        expect(res.body.items[0]).toMatchObject({ id: expect.any(String), name: expect.any(String), status: expect.any(String) });
      }
    });
  });

  describe('Wilayas — référentiel 69 entrées (B.3)', () => {
    it('GET /referential/wilayas renvoie les 69 wilayas (codes 01 → 69)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/referential/wilayas')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(200);
      expect(res.body).toHaveLength(69);
      expect(res.body[0].code).toBe('01');
      expect(res.body[68].code).toBe('69');
    });
  });
});
