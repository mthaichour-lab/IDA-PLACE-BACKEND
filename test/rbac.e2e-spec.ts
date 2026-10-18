import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';

/**
 * RBAC e2e — B.7 : `GET /api/v1/me` pour les 6 rôles dev (DevAuthProvider),
 * privilèges effectifs conformes à la matrice par défaut
 * (`common/rbac/roles-privileges.ts`), et blocage absolu d'AUDITEUR_CSA sur
 * toute action d'écriture, quel que soit le module.
 */
describe('RBAC (B.7) — /api/v1/me et garde de privilèges', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const ALL_PRIVILEGES = [
    'admin', 'matchDecide', 'seal', 'synth', 'remind', 'pvSign', 'pay',
    'penaltyOrder', 'decide', 'sanction', 'params', 'grid', 'exchange',
    'insert', 'refedit', 'import', 'bill',
    // QUESTIONS_UAR.md §11/§12 (décision Product Owner 2026-10-18) —
    // nouveaux privilèges dédiés OPERATEUR_PLACE/ADMIN_UAR (+ MEMBRE_COMMISSION pour closeQuarter).
    'closeQuarter', 'onboardCompany',
  ];

  it.each([
    ['OPERATEUR_PLACE', ALL_PRIVILEGES, undefined],
    ['ADMIN_UAR', ALL_PRIVILEGES, undefined],
    ['MEMBRE_COMMISSION', ['decide', 'sanction', 'penaltyOrder', 'pvSign', 'synth', 'closeQuarter'], undefined],
    ['CORRESPONDANT_IDA', ['matchDecide', 'exchange', 'insert', 'import', 'refedit', 'remind', 'synth'], 'CAAT'],
    ['TRESORIER', ['pay', 'bill', 'synth'], 'CAAT'],
    ['AUDITEUR_CSA', [], undefined],
  ])('renvoie le rôle, les privilèges et la compagnie attendus pour %s', async (role, expectedPrivileges, expectedCompany) => {
    const res = await request(app.getHttpServer()).get('/api/v1/me').set('x-dev-user', role).expect(200);

    expect(res.body.role).toBe(role);
    expect(new Set(res.body.privileges)).toEqual(new Set(expectedPrivileges));
    expect(res.body.company).toBe(expectedCompany);
    expect(res.body.user).toMatchObject({ id: expect.any(String), name: expect.any(String), email: expect.any(String) });
  });

  it('refuse (401/403 selon le guard) un appel sans en-tête x-dev-user reconnu', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/me');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  describe('AUDITEUR_CSA — lecture seule imposée indépendamment de la matrice (B.7)', () => {
    it('bloque POST /matching/:id/decide avec 403 normalisé', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/matching/any-id/decide')
        .set('x-dev-user', 'AUDITEUR_CSA')
        .send({ action: 'confirm' })
        .expect(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('bloque POST /claims/import avec 403 normalisé', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/claims/import')
        .set('x-dev-user', 'AUDITEUR_CSA')
        .attach('file', Buffer.from('header\n'), 'empty.csv')
        .expect(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('bloque POST /referential/companies (écriture) avec 403', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/referential/companies')
        .set('x-dev-user', 'AUDITEUR_CSA')
        .send({ code: 'XXXX', name: 'X', color: '#111111', kind: 'INSURER', feedMode: 'API' })
        .expect(403);
    });

    it('laisse passer les lectures (GET /referential/companies) avec 200', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/referential/companies')
        .set('x-dev-user', 'AUDITEUR_CSA')
        .expect(200);
      expect(res.body).toHaveProperty('items');
    });
  });

  it('un rôle avec le privilège requis (OPERATEUR_PLACE) peut décider — pas de 403', async () => {
    // id inconnu => 404 normalisé (pas 403), preuve que la garde de privilège
    // a bien laissé passer avant d'atteindre la résolution de la ressource.
    const res = await request(app.getHttpServer())
      .post('/api/v1/matching/unknown-id/decide')
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .send({ action: 'confirm' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
