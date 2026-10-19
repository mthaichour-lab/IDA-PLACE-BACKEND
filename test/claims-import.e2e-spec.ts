import { INestApplication } from '@nestjs/common';
import * as path from 'path';
import request from 'supertest';
import { createTestApp } from './utils/test-app';

/**
 * Import des dossiers (écran 3) e2e — B.4/B.6. Vérifie le rapport ligne à
 * ligne et le verdict Éligible IDA / Hors IDA sur un fichier CSV de test
 * (2 lignes : 1 cas éligible, 1 cas hors IDA couvrant plusieurs motifs
 * d'inéligibilité B.6).
 */
describe('Import des dossiers — POST /api/v1/claims/import (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /claims/import/columns expose les 47 colonnes du modèle (B.4)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/claims/import/columns')
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .expect(200);
    expect(res.body).toHaveLength(47);
    expect(res.body[0]).toMatchObject({ index: 1, key: 'numEconstat' });
  });

  it('rejette un import sans fichier (BAD_REQUEST normalisé)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/claims/import')
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it("exige le privilège 'import' (CORRESPONDANT_IDA l'a, TRESORIER ne l'a pas)", async () => {
    // Sans pièce jointe : la garde répond 403 avant toute lecture du corps
    // multipart (avec un fichier en flux, le serveur coupait la connexion
    // pendant l'envoi → ECONNRESET intermittent côté client).
    await request(app.getHttpServer())
      .post('/api/v1/claims/import')
      .set('x-dev-user', 'TRESORIER')
      .expect(403);
  });

  it('retourne un rapport ligne à ligne avec verdict ELIGIBLE_IDA / HORS_IDA (B.6)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/claims/import')
      .query({ company: 'CAAT' })
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .attach('file', path.join(__dirname, 'fixtures/import-eligible-ineligible.csv'))
      .expect(201);

    expect(res.body).toMatchObject({
      totalRows: 2,
      eligibleCount: 1,
      ineligibleCount: 1,
    });
    expect(res.body.rows).toHaveLength(2);

    const [eligibleRow, ineligibleRow] = res.body.rows;

    expect(eligibleRow.verdict).toBe('ELIGIBLE_IDA');
    expect(eligibleRow.reasons).toEqual([]);
    expect(eligibleRow.data.numEconstat).toBe('ECN-E2E-0001');

    expect(ineligibleRow.verdict).toBe('HORS_IDA');
    expect(ineligibleRow.reasons.length).toBeGreaterThan(0);
    // Motifs attendus (B.6) : nombre de véhicules ≠ 2 (Art.4), dommages
    // corporels (Art.3), montant > plafond (Art.4), forclusion (Art.19),
    // exclusion contractuelle (Art.5-6), pièces manquantes (Art.13).
    const joined = ineligibleRow.reasons.join(' | ');
    expect(joined).toMatch(/Art\. 4/);
    expect(joined).toMatch(/Art\. 3/);
    expect(joined).toMatch(/Art\. 19/);
    expect(joined).toMatch(/Art\. 5-6/);
    expect(joined).toMatch(/Art\. 13/);
  });

  it('les dossiers importés apparaissent ensuite dans GET /claims', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/claims/import')
      .query({ company: 'CAAT' })
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .attach('file', path.join(__dirname, 'fixtures/import-eligible-ineligible.csv'))
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/v1/claims')
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .expect(200);

    const found = res.body.items.find((c: { numEconstat: string }) => c.numEconstat === 'ECN-E2E-0001');
    expect(found).toBeDefined();
    expect(found.eligibilityVerdict).toBe('ELIGIBLE_IDA');
  });
});
