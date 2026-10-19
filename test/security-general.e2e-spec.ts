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
    it('un nom de fichier contenant "../" ne remonte jamais dans la clé ni dans les métadonnées (SEC-10 : clé aléatoire)', async () => {
      // Multer réduit déjà le nom multipart à son dernier segment ; le service refuse
      // en plus tout « .. », « / » ou caractère de contrôle résiduel (test unitaire).
      const res = await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', Buffer.from('%PDF-1.4 contenu test'), { filename: '../../../../etc/cron.d/x', contentType: 'application/pdf' })
        .expect(201);
      expect(res.body.filename).toBe('x');
      expect(JSON.stringify(res.body)).not.toContain('..');
      expect(res.body).not.toHaveProperty('key');
    });

    it('SEC-29 : un HTML renommé en .pdf est refusé (signature des octets)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', Buffer.from('<html><script>alert(document.cookie)</script></html>'), { filename: 'constat.pdf', contentType: 'application/pdf' })
        .expect(400);
      expect(res.body.code).toBe('TYPE_NON_AUTORISE');
    });

    it('SEC-29 : le fichier de test EICAR est refusé', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/documents/upload')
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .attach('file', Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'), { filename: 'eicar.pdf', contentType: 'application/pdf' })
        .expect(400);
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
        .get('/api/v1/recours/00000000-0000-4000-8000-000000000000') // SEC-44 : identifiant au format UUID (sinon 400 de validation)
        .set('x-dev-user', 'OPERATEUR_PLACE')
        .expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(res.body.message).not.toMatch(/at \w+\.|node_modules|\.ts:\d+/);
    });
  });
});
