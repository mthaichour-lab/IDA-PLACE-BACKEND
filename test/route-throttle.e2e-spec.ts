import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './utils/test-app';

/**
 * SEC-13 (phase 2) — limites de débit PAR ROUTE (`@RouteThrottle`, voir
 * `src/common/throttle/route-throttle.ts`), plus strictes que la limite
 * globale. Le throttler est désactivé par défaut sous Jest : ce bloc
 * l'active explicitement (`THROTTLE_ENABLED=true`) avec des seuils bas.
 */

const ENV_SNAPSHOT = { ...process.env };
function setEnv(overrides: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function restoreEnv(): void {
  for (const k of Object.keys(process.env)) if (!(k in ENV_SNAPSHOT)) delete process.env[k];
  Object.assign(process.env, ENV_SNAPSHOT);
}

const DEV = (role: string) => ({ 'x-dev-user': role });

describe('SEC-13 — limites de débit par route', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    setEnv({
      AUTH_PROVIDER: 'dev',
      THROTTLE_ENABLED: 'true',
      THROTTLE_LIMIT: '1000',
      THROTTLE_TTL_SECONDS: '60',
      THROTTLE_LEDGER_VERIFY_LIMIT: '2',
      THROTTLE_IMPORT_LIMIT: '1',
      THROTTLE_ADMIN_LIMIT: '2',
      TRUST_PROXY_HOPS: '1',
    });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it('GET /ledger/verify : 429 au-delà de la limite de la route, alors que la limite globale n’est pas atteinte', async () => {
    const verify = (ip: string) => http().get('/api/v1/ledger/verify').set(DEV('AUDITEUR_CSA')).set('X-Forwarded-For', ip);
    await verify('198.51.100.1').expect(200);
    await verify('198.51.100.1').expect(200);
    const limited = await verify('198.51.100.1').expect(429);
    expect(limited.body.code).toBe('TOO_MANY_REQUESTS');
    // Un autre client garde son quota ; la même adresse garde la limite globale sur les autres routes.
    await verify('198.51.100.2').expect(200);
    await http().get('/api/v1/ledger').set(DEV('AUDITEUR_CSA')).set('X-Forwarded-For', '198.51.100.1').expect(200);
  });

  it('POST /claims/import : limite stricte appliquée avant toute analyse (y compris sans fichier)', async () => {
    const importCall = () => http().post('/api/v1/claims/import').set(DEV('CORRESPONDANT_IDA')).set('X-Forwarded-For', '198.51.100.3');
    await importCall().expect(400);
    await importCall().expect(429);
  });

  it('administration (utilisateurs, matrice) : limite commune au contrôleur, par route', async () => {
    const users = () => http().get('/api/v1/admin/users').set(DEV('ADMIN_UAR')).set('X-Forwarded-For', '198.51.100.4');
    await users().expect(200);
    await users().expect(200);
    await users().expect(429);
  });
});
