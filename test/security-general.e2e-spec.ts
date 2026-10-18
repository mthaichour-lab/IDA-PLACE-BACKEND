import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';

/**
 * Revue sécurité 2026-10-18 (dimension générale, hors scoping tenant —
 * voir `security-tenant-scope.e2e-spec.ts` pour cette autre revue).
 */
describe('Revue sécurité générale (2026-10-18) — traversée de chemin, limites d’upload, matrice RBAC', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('DocumentsModule — assainissement du nom de fichier (traversée de chemin)', () => {
    it("un nom de fichier contenant \"../\" n'échappe jamais du préfixe compagnie dans la clé renvoyée", async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', Buffer.from('%PDF-1.4 contenu test'), { filename: '../../../../etc/cron.d/x', contentType: 'application/pdf' })
        .expect(201);

      expect(res.body.key).toMatch(/^place\/\d+-x$/);
      expect(res.body.key).not.toContain('..');
    });

    it('un type de fichier non autorisé (ex: .exe) est refusé avec un 400', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', Buffer.from('MZ...'), { filename: 'malware.exe', contentType: 'application/x-msdownload' })
        .expect(400);
    });

    it('un PDF légitime est accepté (comportement normal inchangé)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', Buffer.from('%PDF-1.4 contenu test'), { filename: 'constat.pdf', contentType: 'application/pdf' })
        .expect(201);
    });
  });

  describe('ClaimsModule — type de fichier d’import', () => {
    it('un type de fichier non autorisé (ex: .exe) pour POST /claims/import est refusé avec un 400', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/claims/import')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', Buffer.from('MZ...'), { filename: 'malware.exe', contentType: 'application/x-msdownload' })
        .expect(400);
    });
  });

  describe('AdminModule — GET /admin/roles/matrix (B.7)', () => {
    it("refuse avec un 403 qu'un CORRESPONDANT_IDA lise la matrice RBAC interne", async () => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/roles/matrix')
        .set('x-dev-user', 'CORRESPONDANT_IDA')
        .expect(403);
    });

    it('autorise un rôle place (OPERATEUR_PLACE)', async () => {
      await request(app.getHttpServer()).get('/api/v1/admin/roles/matrix').set('x-dev-user', 'OPERATEUR_PLACE').expect(200);
    });
  });

  describe('PUT /admin/roles/matrix — validation de la charge utile', () => {
    it('refuse avec un 400 une clé de rôle inconnue dans le payload', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/admin/roles/matrix')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ matrix: { ROLE_INVENTE: { admin: true } } })
        .expect(400);
    });

    it('refuse avec un 400 une clé de privilège inconnue', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/admin/roles/matrix')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .send({ matrix: { TRESORIER: { superAdminInvente: true } } })
        .expect(400);
    });
  });

  describe('NormalizedExceptionFilter — pas de fuite de message brut (cas HTTP réel)', () => {
    it('une ressource introuvable renvoie un message normalisé, jamais une trace interne', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/recours/id-totalement-inconnu')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(res.body.message).not.toMatch(/at \w+\.|node_modules|\.ts:\d+/);
    });
  });
});
