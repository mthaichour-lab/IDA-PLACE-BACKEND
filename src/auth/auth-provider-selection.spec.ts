import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { EXAMPLE_DEV_JWT_SECRET } from '../common/config/env.validation';
import { RbacService } from '../common/rbac/rbac.service';
import { selectAuthProvider } from './auth.module';
import { DevAuthProvider } from './strategies/dev-auth.provider';
import { KeycloakStrategy } from './strategies/keycloak.strategy';

const STRONG = 's'.repeat(48);
const KEYCLOAK = { KEYCLOAK_BASE_URL: 'http://kc.test', KEYCLOAK_REALM: 'ida-place', KEYCLOAK_CLIENT_ID: 'ida-place-api' };

/**
 * SEC-01 (revue sécurité 2026-10-19) — test unitaire du factory
 * d'authentification : matrice NODE_ENV × AUTH_PROVIDER, sans conteneur Nest.
 */
describe('selectAuthProvider — matrice NODE_ENV × AUTH_PROVIDER (SEC-01)', () => {
  const dev = new DevAuthProvider(new RbacService());
  const keycloak = { assertConfigured: jest.fn() } as unknown as KeycloakStrategy;

  it.each([
    ['production', 'dev', /"keycloak" en production/],
    ['production', undefined, /"keycloak" en production/],
    ['production', 'Dev', /"keycloak" en production/],
    ['development', undefined, /doit valoir "dev" ou "keycloak"/],
    ['development', 'keycloack', /doit valoir "dev" ou "keycloak"/],
  ])('NODE_ENV=%s AUTH_PROVIDER=%s → démarrage refusé', (nodeEnv, provider, message) => {
    expect(() => selectAuthProvider({ NODE_ENV: nodeEnv, AUTH_PROVIDER: provider, DEV_JWT_SECRET: STRONG }, dev, keycloak)).toThrow(message);
  });

  it.each(['production', 'development', 'test'])('NODE_ENV=%s AUTH_PROVIDER=keycloak → KeycloakStrategy (configuration vérifiée)', (nodeEnv) => {
    expect(selectAuthProvider({ NODE_ENV: nodeEnv, AUTH_PROVIDER: 'keycloak', ...KEYCLOAK }, dev, keycloak)).toBe(keycloak);
    expect(keycloak.assertConfigured).toHaveBeenCalled();
  });

  it('NODE_ENV=development AUTH_PROVIDER=dev → DevAuthProvider si DEV_JWT_SECRET réel', () => {
    expect(selectAuthProvider({ NODE_ENV: 'development', AUTH_PROVIDER: 'dev', DEV_JWT_SECRET: STRONG }, dev, keycloak)).toBe(dev);
  });

  it('NODE_ENV=development AUTH_PROVIDER=dev → refusé si DEV_JWT_SECRET absent ou public (plus de repli)', () => {
    expect(() => selectAuthProvider({ NODE_ENV: 'development', AUTH_PROVIDER: 'dev' }, dev, keycloak)).toThrow(/DEV_JWT_SECRET est absent/);
    expect(() => selectAuthProvider({ NODE_ENV: 'development', AUTH_PROVIDER: 'dev', DEV_JWT_SECRET: EXAMPLE_DEV_JWT_SECRET }, dev, keycloak)).toThrow(
      /valeur PUBLIQUE/,
    );
  });

  it('NODE_ENV=test AUTH_PROVIDER=dev → accepté (clé éphémère sous Jest)', () => {
    expect(selectAuthProvider({ NODE_ENV: 'test', AUTH_PROVIDER: 'dev' }, dev, keycloak)).toBe(dev);
  });
});

/**
 * Revue sécurité 2026-10-18 + SEC-01 : vérifié aussi sur `AppModule` complet
 * (mêmes conditions que `createTestApp`, mode dégradé sans PostgreSQL réel).
 * L'environnement est restauré après chaque test pour ne jamais fuiter vers
 * un autre fichier exécuté dans le même worker Jest.
 */
describe('Sélection du AuthProvider au démarrage de AppModule', () => {
  const snapshot = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k];
    Object.assign(process.env, snapshot);
  });

  it('échoue au démarrage si AUTH_PROVIDER est absent (jamais un repli silencieux sur dev)', async () => {
    delete process.env.AUTH_PROVIDER;
    await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(/AUTH_PROVIDER doit valoir "dev" ou "keycloak"/);
  });

  it('échoue au démarrage si AUTH_PROVIDER est mal orthographié (ex: "Dev", "keycloack")', async () => {
    process.env.AUTH_PROVIDER = 'Dev';
    await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(/AUTH_PROVIDER doit valoir "dev" ou "keycloak"/);
  });

  it('échoue au démarrage avec NODE_ENV=production et AUTH_PROVIDER=dev (SEC-01)', async () => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'dev',
      DB_HOST: '127.0.0.1',
      DB_NAME: 'ida',
      DB_USER: 'app',
      DB_PASSWORD: 'secret-de-test',
      LEDGER_HMAC_KEY: STRONG,
      CORS_ORIGIN: 'https://ida-place.test',
    });
    await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(/"keycloak" en production/);
  });

  it('démarre normalement avec AUTH_PROVIDER="dev" explicite hors production (comportement inchangé)', async () => {
    process.env.AUTH_PROVIDER = 'dev';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    await app.close();
  });
});
