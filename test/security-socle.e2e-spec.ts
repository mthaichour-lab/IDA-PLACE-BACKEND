import { createPublicKey, generateKeyPairSync } from 'crypto';
import { AddressInfo } from 'net';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { getDevJwtSecret } from '../src/common/config/env.validation';
import { PLACE_ROOM, RealtimeGateway, tenantRoom } from '../src/realtime/realtime.module';
import { createTestApp } from './utils/test-app';

/**
 * Revue sécurité 2026-10-19 — socle (SEC-01, 07, 08, 13, 16, 25, 41, 44, 45).
 * Chaque bloc démarre sa propre application avec la configuration voulue
 * (développement, limitation de débit active, production) ; l'environnement
 * est restauré après chaque bloc.
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
const devJson = (u: Record<string, unknown>) => ({ 'x-dev-user': JSON.stringify(u) });

describe('Socle sécurité — configuration de développement', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    setEnv({ AUTH_PROVIDER: 'dev', CORS_ORIGIN: 'http://localhost:3000', SWAGGER_ENABLED: undefined });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  describe('SEC-16 — journal scellé : contrôle d’accès, pagination, validation', () => {
    it.each(['CORRESPONDANT_IDA', 'TRESORIER'])('%s (rôle compagnie) : 403 sur /ledger et /ledger/verify', async (role) => {
      await http().get('/api/v1/ledger').set(DEV(role)).expect(403);
      await http().get('/api/v1/ledger/verify').set(DEV(role)).expect(403);
    });

    it('AUDITEUR_CSA : lecture et vérification autorisées (aucun privilège requis)', async () => {
      await http().get('/api/v1/ledger').set(DEV('AUDITEUR_CSA')).expect(200);
      const verify = await http().get('/api/v1/ledger/verify').set(DEV('AUDITEUR_CSA')).expect(200);
      expect(verify.body).toMatchObject({ valid: true });
      expect(verify.body.entries).toBeGreaterThan(0);
      expect(typeof verify.body.headHash).toBe('string');
    });

    it('MEMBRE_COMMISSION : lecture autorisée, vérification réservée à l’administration/audit', async () => {
      await http().get('/api/v1/ledger').set(DEV('MEMBRE_COMMISSION')).expect(200);
      await http().get('/api/v1/ledger/verify').set(DEV('MEMBRE_COMMISSION')).expect(403);
    });

    it('lecture paginée {page,total,items}, pageSize ≤ 100, from/to en ISO 8601', async () => {
      const res = await http().get('/api/v1/ledger').query({ page: 1, pageSize: 2 }).set(DEV('OPERATEUR_PLACE')).expect(200);
      expect(res.body).toMatchObject({ page: 1 });
      expect(res.body.items.length).toBeLessThanOrEqual(2);
      expect(res.body.total).toBeGreaterThanOrEqual(res.body.items.length);
      await http().get('/api/v1/ledger').query({ pageSize: 101 }).set(DEV('OPERATEUR_PLACE')).expect(400);
      await http().get('/api/v1/ledger').query({ from: 'hier' }).set(DEV('OPERATEUR_PLACE')).expect(400);
      await http().get('/api/v1/ledger').query({ from: '2026-01-01T00:00:00Z', to: '2999-12-31' }).set(DEV('OPERATEUR_PLACE')).expect(200);
    });
  });

  describe('SEC-25 — matrice des droits et dérogations', () => {
    it('PUT /admin/roles/matrix sans corps typé : 400 (et non 500)', async () => {
      await http().put('/api/v1/admin/roles/matrix').set(DEV('OPERATEUR_PLACE')).send({}).expect(400);
      await http().put('/api/v1/admin/roles/matrix').set(DEV('OPERATEUR_PLACE')).send({ matrix: { TRESORIER: { pay: 'oui' } } }).expect(400);
    });

    it('donner "decide" à un rôle compagnie est refusé (400 PRIVILEGE_RESERVE_PLACE)', async () => {
      const res = await http().put('/api/v1/admin/roles/matrix').set(DEV('OPERATEUR_PLACE')).send({ matrix: { CORRESPONDANT_IDA: { decide: true } } }).expect(400);
      expect(res.body.code).toBe('PRIVILEGE_RESERVE_PLACE');
    });

    it('toute modification de la matrice apparaît dans le journal scellé', async () => {
      await http().put('/api/v1/admin/roles/matrix').set(DEV('OPERATEUR_PLACE')).send({ matrix: { TRESORIER: { remind: true } } }).expect(200);
      const ledger = await http().get('/api/v1/ledger').query({ pageSize: 100 }).set(DEV('ADMIN_UAR')).expect(200);
      const entry = (ledger.body.items as { type: string; summary: string; actor: string }[]).find((e) => e.type === 'RBAC_MATRIX_UPDATED');
      expect(entry).toBeDefined();
      expect(entry!.summary).toContain('TRESORIER.remind false→true');
      expect(entry!.actor).toBe('operateur@finlab.dz');
      expect((await http().get('/api/v1/ledger/verify').set(DEV('ADMIN_UAR')).expect(200)).body.valid).toBe(true);
    });

    it('une dérogation "grant" réservée à la place est refusée pour un utilisateur compagnie', async () => {
      await http()
        .post('/api/v1/admin/users')
        .set(DEV('OPERATEUR_PLACE'))
        .send({ name: 'Trésorier', email: 'tres-e2e@saa.dz', role: 'TRESORIER', companyId: 'SAA', grant: ['closeQuarter'] })
        .expect(400);
    });

    it('SEC-01/SEC-25 : un x-dev-user JSON qui s’attribue "closeQuarter" n’obtient pas ce privilège', async () => {
      const me = await http()
        .get('/api/v1/me')
        .set(devJson({ id: 'x', name: 'X', email: 'x@saa.dz', role: 'TRESORIER', companyId: 'SAA', grant: ['closeQuarter'] }))
        .expect(200);
      expect(me.body.privileges).not.toContain('closeQuarter');
    });
  });

  describe('SEC-08 / SEC-44 — annuaire : conflit, identifiants', () => {
    it('un e-mail déjà utilisé renvoie 409 (jamais une création silencieuse)', async () => {
      const body = { name: 'Doublon', email: 'doublon-e2e@finlab.dz', role: 'OPERATEUR_PLACE' };
      await http().post('/api/v1/admin/users').set(DEV('OPERATEUR_PLACE')).send(body).expect(201);
      const res = await http().post('/api/v1/admin/users').set(DEV('OPERATEUR_PLACE')).send(body).expect(409);
      expect(res.body.code).toBe('CONFLICT');
    });

    it('PUT /admin/users/:id refuse un identifiant qui n’est pas un UUID (400)', async () => {
      await http().put('/api/v1/admin/users/u-1').set(DEV('OPERATEUR_PLACE')).send({ active: false }).expect(400);
      await http().put('/api/v1/admin/users/00000000-0000-4000-8000-0000000000ff').set(DEV('OPERATEUR_PLACE')).send({ active: false }).expect(404);
    });

    it('la création et la modification d’un utilisateur sont journalisées', async () => {
      const created = await http()
        .post('/api/v1/admin/users')
        .set(DEV('ADMIN_UAR'))
        .send({ name: 'Agent', email: 'agent-e2e@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'CAAT' })
        .expect(201);
      await http().put(`/api/v1/admin/users/${created.body.id}`).set(DEV('ADMIN_UAR')).send({ active: false }).expect(200);
      const ledger = await http().get('/api/v1/ledger').query({ pageSize: 100 }).set(DEV('ADMIN_UAR')).expect(200);
      const types = (ledger.body.items as { type: string; ref: string }[]).filter((e) => e.ref === created.body.id).map((e) => e.type);
      expect(types).toEqual(['PLACE_USER_CREATED', 'PLACE_USER_UPDATED']);
    });
  });

  describe('SEC-13 / SEC-44 / SEC-45 — entrées', () => {
    it('?pageSize=100000 est refusé (400)', async () => {
      await http().get('/api/v1/referential/companies').query({ pageSize: 100000 }).set(DEV('OPERATEUR_PLACE')).expect(400);
    });

    it('query parser "simple" : ?companyId[$ne]=X n’est pas un opérateur de filtre', async () => {
      expect(app.getHttpAdapter().getInstance().get('query parser')).toBe('simple');
      const all = await http().get('/api/v1/referential/agencies').query({ pageSize: 100 }).set(DEV('OPERATEUR_PLACE')).expect(200);
      const injected = await http().get('/api/v1/referential/agencies?pageSize=100&companyId[$ne]=X').set(DEV('OPERATEUR_PLACE')).expect(200);
      expect(injected.body.total).toBe(all.body.total);
    });

    it('JSON invalide : 400 normalisé (et non 500), sans écho du contenu', async () => {
      const res = await http().post('/api/v1/admin/users').set(DEV('OPERATEUR_PLACE')).set('Content-Type', 'application/json').send('{"name": "x",').expect(400);
      expect(res.body).toEqual({ code: 'BAD_REQUEST', message: 'Corps de requête illisible (JSON invalide).' });
    });

    it('corps JSON de plus de 1 Mo : 413', async () => {
      const res = await http()
        .post('/api/v1/admin/users')
        .set(DEV('OPERATEUR_PLACE'))
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ name: 'x'.repeat(1_100_000) }))
        .expect(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('SEC-41 — Swagger et CSP', () => {
    it('hors production, Swagger est servi sans CSP ; l’API garde une CSP', async () => {
      const docs = await http().get('/api/docs-json').expect(200);
      expect(docs.headers['content-security-policy']).toBeUndefined();
      const api = await http().get('/api/v1/health/live').expect(200);
      expect(api.headers['content-security-policy']).toContain("default-src 'self'");
    });
  });

  describe('SEC-08 — sondes', () => {
    it('GET /health/live : 200 sans authentification', async () => {
      expect((await http().get('/api/v1/health/live').expect(200)).body).toEqual({ status: 'ok' });
    });
  });
});

describe('SEC-07 — passerelle temps réel (deux compagnies + place)', () => {
  let app: NestExpressApplication;
  let url: string;
  const sockets: Socket[] = [];

  function connect(auth: Record<string, unknown>): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = io(`${url}/realtime`, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
      sockets.push(socket);
      const timer = setTimeout(() => reject(new Error('connexion WS non établie')), 5000);
      socket.on('connect', () => {
        // Laisse le temps au serveur de terminer handleConnection (join des salons).
        setTimeout(() => {
          clearTimeout(timer);
          resolve(socket);
        }, 150);
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function received(socket: Socket, event: string, waitMs = 400): Promise<unknown[]> {
    const payloads: unknown[] = [];
    socket.on(event, (p: unknown) => payloads.push(p));
    return new Promise((resolve) => setTimeout(() => resolve(payloads), waitMs));
  }

  beforeAll(async () => {
    setEnv({ AUTH_PROVIDER: 'dev', CORS_ORIGIN: 'http://localhost:3000' });
    app = await createTestApp();
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await app.close();
    restoreEnv();
  });

  it('un client de la compagnie X ne reçoit aucun événement concernant uniquement Y (et la place reçoit tout)', async () => {
    const caat = await connect({ devUser: { id: 'c', name: 'C', email: 'c@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'CAAT' } });
    const saa = await connect({ devUser: { id: 's', name: 'S', email: 's@saa.dz', role: 'CORRESPONDANT_IDA', companyId: 'SAA' } });
    const place = await connect({ devUser: 'OPERATEUR_PLACE' });

    const gotCaat = received(caat, 'match.updated');
    const gotSaa = received(saa, 'match.updated');
    const gotPlace = received(place, 'match.updated');
    const gateway = app.get(RealtimeGateway);
    gateway.emitEvent('match.updated', { id: 'm-saa', state: 'CONFIRME' }, { rooms: [tenantRoom('SAA'), PLACE_ROOM] });
    gateway.emitEvent('match.updated', { id: 'm-place' }); // défaut : PLACE_ROOM uniquement

    expect(await gotCaat).toEqual([]);
    expect(await gotSaa).toEqual([{ id: 'm-saa', state: 'CONFIRME' }]);
    expect(await gotPlace).toEqual([{ id: 'm-saa', state: 'CONFIRME' }, { id: 'm-place' }]);
  });

  it('une connexion non authentifiée est fermée', async () => {
    const socket = io(`${url}/realtime`, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(socket);
    const reason = await new Promise<string>((resolve) => socket.on('disconnect', (r) => resolve(r)));
    expect(reason).toBe('io server disconnect');
  });

  it('le client est déconnecté à l’expiration de son jeton', async () => {
    const token = jwt.sign({ id: 'op', name: 'Op', email: 'op@finlab.dz', role: 'OPERATEUR_PLACE' }, getDevJwtSecret(), { expiresIn: 2 });
    const socket = await connect({ token });
    const reason = await new Promise<string>((resolve) => socket.on('disconnect', (r) => resolve(r)));
    expect(reason).toBe('io server disconnect');
  }, 10_000);

  it('CORS WebSocket : origine autorisée seulement (jamais "*")', async () => {
    const allowed = await request(app.getHttpServer()).get('/socket.io/').query({ EIO: '4', transport: 'polling' }).set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const evil = await request(app.getHttpServer()).get('/socket.io/').query({ EIO: '4', transport: 'polling' }).set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('SEC-13 — limitation de débit et trust proxy', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    setEnv({ AUTH_PROVIDER: 'dev', THROTTLE_ENABLED: 'true', THROTTLE_LIMIT: '5', THROTTLE_TTL_SECONDS: '60', TRUST_PROXY_HOPS: '1' });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it('au-delà du seuil, l’API répond 429 ; un autre client (X-Forwarded-For) garde son quota', async () => {
    const call = (ip: string) => request(app.getHttpServer()).get('/api/v1/me').set(DEV('OPERATEUR_PLACE')).set('X-Forwarded-For', ip);
    for (let i = 0; i < 5; i++) await call('203.0.113.10').expect(200);
    const limited = await call('203.0.113.10').expect(429);
    expect(limited.body.code).toBe('TOO_MANY_REQUESTS');
    await call('203.0.113.11').expect(200);
  });

  it('les sondes ne sont pas limitées', async () => {
    for (let i = 0; i < 8; i++) await request(app.getHttpServer()).get('/api/v1/health/live').set('X-Forwarded-For', '203.0.113.12').expect(200);
  });
});

describe('Configuration de production (SEC-01, SEC-08, SEC-15, SEC-41)', () => {
  const KID = 'prod-test-key';
  const ISSUER = 'http://keycloak.test/realms/ida-place';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const PRODUCTION_ENV = {
    NODE_ENV: 'production',
    AUTH_PROVIDER: 'keycloak',
    KEYCLOAK_BASE_URL: 'http://keycloak.test',
    KEYCLOAK_REALM: 'ida-place',
    KEYCLOAK_CLIENT_ID: 'ida-place-api',
    KEYCLOAK_ALLOWED_CLIENTS: 'ida-place-web',
    // Base volontairement injoignable (port fermé) : comportement « base arrêtée ».
    DB_HOST: '127.0.0.1',
    DB_PORT: '1',
    DB_NAME: 'ida_place',
    DB_USER: 'ida_place_app',
    DB_PASSWORD: 'mot-de-passe-de-test-production',
    DB_SSL: 'false',
    LEDGER_HMAC_KEY: 'p'.repeat(48),
    // SEC-11 (branche dossiers) : stockage objet obligatoire en production —
    // configuration factice (aucun appel S3 au démarrage).
    S3_ENABLED: 'true',
    S3_ENDPOINT: 'http://minio.test:9000',
    S3_BUCKET: 'ida-place-docs',
    S3_ACCESS_KEY: 'test-access-key',
    S3_SECRET_KEY: 'test-secret-key',
    CORS_ORIGIN: 'https://ida-place.test',
    SWAGGER_ENABLED: undefined,
    THROTTLE_ENABLED: undefined,
  };
  let app: NestExpressApplication;
  const originalFetch = global.fetch;
  const http = () => request(app.getHttpServer());

  function bearer(): string {
    return jwt.sign(
      { sub: 'kc-admin', typ: 'Bearer', azp: 'ida-place-web', email: 'admin@uar.dz', email_verified: true, realm_access: { roles: ['ADMIN_UAR'] } },
      privateKey,
      { algorithm: 'RS256', keyid: KID, issuer: ISSUER, expiresIn: '5m' },
    );
  }

  beforeAll(async () => {
    const jwk = { ...(createPublicKey(publicKey).export({ format: 'jwk' }) as Record<string, unknown>), kid: KID, alg: 'RS256', use: 'sig' };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ keys: [jwk] }) }) as unknown as typeof fetch;
    setEnv(PRODUCTION_ENV);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    global.fetch = originalFetch;
    restoreEnv();
  });

  it('NODE_ENV=production AUTH_PROVIDER=dev : démarrage refusé avec un message explicite', async () => {
    setEnv({ AUTH_PROVIDER: 'dev' });
    try {
      await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(/AUTH_PROVIDER doit valoir "keycloak" en production/);
    } finally {
      setEnv({ AUTH_PROVIDER: 'keycloak' });
    }
  });

  it('une requête portant x-dev-user sans jeton reçoit 401', async () => {
    await http().get('/api/v1/me').set(DEV('ADMIN_UAR')).expect(401);
    await http().get('/api/v1/me').set(devJson({ id: 'x', name: 'x', email: 'x@x', role: 'ADMIN_UAR' })).expect(401);
  });

  it('base arrêtée : sonde de disponibilité en échec (503), sonde de vie OK', async () => {
    await http().get('/api/v1/health/live').expect(200);
    const ready = await http().get('/api/v1/health/ready').expect(503);
    expect(ready.body.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('base arrêtée : jeton valide mais requêtes en 503 (aucun repli mémoire, aucune donnée fictive)', async () => {
    const token = bearer();
    await http().get('/api/v1/ledger/verify').set('Authorization', `Bearer ${token}`).expect(503);
    await http()
      .post('/api/v1/admin/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Agent', email: 'agent@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'CAAT' })
      .expect(503);
    await http().get('/api/v1/referential/companies').set('Authorization', `Bearer ${token}`).expect(503);
  });

  it('GET /api/docs en production : 404 (Swagger désactivé)', async () => {
    await http().get('/api/docs').expect(404);
    await http().get('/api/docs-json').expect(404);
  });
});
