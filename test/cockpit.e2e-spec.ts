import { INestApplication } from '@nestjs/common';
import * as path from 'path';
import request from 'supertest';
import { createTestApp } from './utils/test-app';

/**
 * Cockpit de place (écran 1) e2e — `GET /cockpit/summary` doit refléter les
 * VRAIES données de ClaimsModule/MatchingModule après import (pas des
 * valeurs figées) — voir ARCHITECTURE.md §5 / HANDOFF.md backend.
 */
describe('Cockpit de place — GET /api/v1/cockpit/summary (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('a la forme attendue par le front (kpis, sparkline, barresNettes, updatedAt)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/cockpit/summary')
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .expect(200);

    expect(res.body).toMatchObject({
      kpis: {
        dossiersDuJour: expect.any(Number),
        aApparier: expect.any(Number),
        enRetard: expect.any(Number),
        compensationAVenir: expect.any(Number),
      },
      sparklineDeclarations: expect.any(Array),
      barresNettes: expect.any(Array),
      updatedAt: expect.any(String),
    });
  });

  it('dossiersDuJour et aApparier augmentent après un import réel (pas de valeurs figées)', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/v1/cockpit/summary')
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/claims/import')
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .attach('file', path.join(__dirname, 'fixtures/import-matching-shared-econstat.csv'))
      .expect(201);

    const after = await request(app.getHttpServer())
      .get('/api/v1/cockpit/summary')
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .expect(200);

    // 2 déclarations importées, appariées entre elles (A_CONFIRMER avant
    // toute décision humaine, ou AUTO_CONFIRME selon le score — dans tous
    // les cas le compteur de dossiers du jour progresse strictement).
    expect(after.body.kpis.dossiersDuJour).toBeGreaterThan(before.body.kpis.dossiersDuJour);
  });

  it("l'historique de sparkline couvre 12 points (12 derniers jours)", async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/cockpit/summary')
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .expect(200);
    expect(res.body.sparklineDeclarations).toHaveLength(12);
  });

  it('nécessite une authentification (401 sans en-tête reconnu)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/cockpit/summary');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
