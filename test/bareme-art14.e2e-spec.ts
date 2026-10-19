import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CLAIM_IMPORT_COLUMNS } from '../src/claims/claim-47-columns';
import { CLAIM_IMPORT_EXTENSION_COLUMNS } from '../src/claims/claim-extension-columns';
import { createTestApp } from './utils/test-app';

/**
 * Barème Art. 14 et catégorie de véhicule — décision PO §5. Sans PostgreSQL
 * (repli mémoire), comme l'application démarrée dans cet environnement.
 */
describe('Barème Art. 14 — décision PO §5 (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  function companyUser(companyId: string) {
    return JSON.stringify({ id: `corr-${companyId}`, name: `Correspondant ${companyId}`, email: `c@${companyId}.test`, role: 'CORRESPONDANT_IDA', companyId });
  }

  /** Importe une déclaration (modèle v2) et renvoie l'id du dossier créé. */
  async function importClaim(numEconstat: string, company: string, counterparty: string, extension: Record<string, string> = {}): Promise<{ id: string; warnings: unknown[] }> {
    const base: Record<string, string> = {
      numEconstat,
      compagnieA: company,
      compagnieB: counterparty,
      dateAccident: '2026-09-10',
      wilaya: '16',
      nombreVehicules: '2',
      territoire: 'ALGERIE',
      responsabiliteDeclareeA: '100',
      responsabiliteDeclareeB: '0',
      canalDeclaration: 'IMPORT',
    };
    const header = [...CLAIM_IMPORT_COLUMNS, ...CLAIM_IMPORT_EXTENSION_COLUMNS].map((c) => c.label).join(';');
    const row = [...CLAIM_IMPORT_COLUMNS.map((c) => base[c.key] ?? ''), ...CLAIM_IMPORT_EXTENSION_COLUMNS.map((c) => extension[c.key] ?? '')].join(';');
    const res = await http()
      .post('/api/v1/claims/import')
      .set('x-dev-user', 'OPERATEUR_PLACE')
      .attach('file', Buffer.from(`${header}\n${row}\n`, 'utf-8'), 'bareme.csv')
      .expect(201);
    const list = await http().get('/api/v1/claims').query({ pageSize: 1000 }).set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
    return { id: list.body.items.find((c: { numEconstat: string }) => c.numEconstat === numEconstat).id, warnings: res.body.warnings };
  }

  describe('CORRESPONDANT_IDA : 403 en écriture sur le référentiel', () => {
    it.each([
      ['post', '/api/v1/referential/bareme-versions', { label: 'x' }],
      ['put', '/api/v1/referential/bareme-versions/any', { label: 'x' }],
      ['post', '/api/v1/referential/bareme-versions/any/cases', { code: 'B01', label: 'x', partA: 50, partB: 50 }],
      ['put', '/api/v1/referential/bareme-versions/any/cases/B01', { label: 'x' }],
      ['delete', '/api/v1/referential/bareme-versions/any/cases/B01', undefined],
      ['post', '/api/v1/referential/bareme-versions/any/validate', {}],
      ['post', '/api/v1/referential/bareme-versions/any/archive', {}],
      ['post', '/api/v1/referential/vehicle-categories', { code: 'VL', label: 'x' }],
      ['put', '/api/v1/referential/vehicle-categories/VL', { label: 'x' }],
      ['post', '/api/v1/referential/vehicle-categories/VL/validate', {}],
    ])('%s %s → 403', async (method, url, body) => {
      const req = (http() as unknown as Record<string, (u: string) => request.Test>)[method](url).set('x-dev-user', 'CORRESPONDANT_IDA');
      const res = await (body === undefined ? req : req.send(body));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('OPERATEUR_PLACE (params) ne valide pas : validateRef réservé à ADMIN_UAR', async () => {
      await http().post('/api/v1/referential/bareme-versions/any/validate').set('x-dev-user', 'OPERATEUR_PLACE').expect(403);
    });
  });

  describe('PATCH /claims/:id/responsabilite', () => {
    it('CORRESPONDANT_IDA ne patche pas le dossier d’une autre compagnie (403), même partie adverse déclarée', async () => {
      const other = await importClaim('E2E-BAR-OTHER', 'SAA', 'CNMA');
      await http().patch(`/api/v1/claims/${other.id}/responsabilite`).set('x-dev-user', companyUser('CAAT')).send({ circonstancesA: [1] }).expect(403);
      const adverse = await importClaim('E2E-BAR-ADV', 'SAA', 'CAAT');
      await http().patch(`/api/v1/claims/${adverse.id}/responsabilite`).set('x-dev-user', companyUser('CAAT')).send({ circonstancesA: [1] }).expect(403);
    });

    it('parcours complet : saisie, validation UAR, code refusé puis accepté, confrontation', async () => {
      const own = await importClaim('E2E-BAR-OWN', 'CAAT', 'SAA', { baremeCode: 'E2E01' });
      expect(own.warnings).toEqual([expect.objectContaining({ rowNumber: 1, column: 51, code: 'BAREME_NON_PUBLIE' })]);

      await http().patch(`/api/v1/claims/${own.id}/responsabilite`).set('x-dev-user', 'CORRESPONDANT_IDA').send({ baremeCode: 'E2E01' }).expect(400);
      await http().patch(`/api/v1/claims/${own.id}/responsabilite`).set('x-dev-user', 'CORRESPONDANT_IDA').send({ circonstancesA: [18] }).expect(400);

      const version = await http().post('/api/v1/referential/bareme-versions').set('x-dev-user', 'OPERATEUR_PLACE').send({ label: 'Barème e2e' }).expect(201);
      await http()
        .post(`/api/v1/referential/bareme-versions/${version.body.id}/cases`)
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ code: 'E2E01', label: 'Cas e2e', partA: 60, partB: 50 })
        .expect(400);
      await http()
        .post(`/api/v1/referential/bareme-versions/${version.body.id}/cases`)
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ code: 'E2E01', label: 'Cas e2e', partA: 75, partB: 25 })
        .expect(201);
      await http().post(`/api/v1/referential/bareme-versions/${version.body.id}/validate`).set('x-dev-user', 'ADMIN_UAR').expect(201);
      await http()
        .put(`/api/v1/referential/bareme-versions/${version.body.id}/cases/E2E01`)
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ label: 'corrigé' })
        .expect(409);

      const patched = await http()
        .patch(`/api/v1/claims/${own.id}/responsabilite`)
        .set('x-dev-user', 'CORRESPONDANT_IDA')
        .send({ baremeCode: 'E2E01', circonstancesA: [8] })
        .expect(200);
      expect(patched.body).toMatchObject({ baremeCode: 'E2E01', baremeVersionId: version.body.id, circonstancesA: [8], responsabiliteDeclareeA: 100 });

      const queue = await http().get('/api/v1/matching/queue').query({ pageSize: 1000 }).set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      const item = queue.body.items.find((i: { refA: string }) => i.refA === 'E2E-BAR-OWN');
      const detail = await http().get(`/api/v1/matching/${item.id}`).set('x-dev-user', 'CORRESPONDANT_IDA').expect(200);
      expect(detail.body).toMatchObject({
        claimAId: own.id,
        divergence: false,
        responsabiliteA: { baremeCode: 'E2E01', responsabiliteDeclareeA: 100, tauxSelonBareme: { partA: 75, partB: 25 } },
      });
      expect(item).not.toHaveProperty('claimAId');

      const summary = await http().get('/api/v1/stats/summary').set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      expect(summary.body.baremeCodes.items).toContainEqual({ code: 'E2E01', count: 1 });
      expect(summary.body.baremeCodes.sansValeur).toBeGreaterThan(0);
    });

    it('GET /claims/import/columns reste à 47 colonnes ; le modèle v2 en compte 53', async () => {
      await http().get('/api/v1/claims/import/columns').set('x-dev-user', 'OPERATEUR_PLACE').expect(200).expect((r) => expect(r.body).toHaveLength(47));
      const v2 = await http().get('/api/v1/claims/import/columns/v2').set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
      expect(v2.body).toHaveLength(53);
      expect(v2.body[47]).toMatchObject({ index: 48, key: 'circonstancesA' });
    });
  });
});
