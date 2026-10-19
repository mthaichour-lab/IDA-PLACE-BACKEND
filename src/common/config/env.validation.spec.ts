import {
  EnvValidationError,
  EXAMPLE_DEV_JWT_SECRET,
  EXAMPLE_LEDGER_HMAC_KEY,
  getCorsOrigins,
  getDevJwtSecret,
  getLedgerHmacKey,
  getThrottleSettings,
  isSwaggerEnabled,
  validateEnv,
} from './env.validation';

const STRONG = 'x'.repeat(48);

/** Configuration de production complète et acceptable. */
function productionEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    AUTH_PROVIDER: 'keycloak',
    KEYCLOAK_BASE_URL: 'https://auth.ida-place.dz',
    KEYCLOAK_REALM: 'ida-place',
    KEYCLOAK_CLIENT_ID: 'ida-place-api',
    DB_HOST: 'db.internal',
    DB_NAME: 'ida_place',
    DB_USER: 'ida_place_app',
    DB_PASSWORD: 'un-mot-de-passe-robuste',
    LEDGER_HMAC_KEY: STRONG,
    CORS_ORIGIN: 'https://ida-place.dz',
    ...overrides,
  };
}

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    validateEnv(env);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(EnvValidationError);
    return (e as EnvValidationError).problems;
  }
}

const devKeycloak = { KEYCLOAK_BASE_URL: 'http://kc', KEYCLOAK_REALM: 'r', KEYCLOAK_CLIENT_ID: 'c' };

describe('validateEnv — configuration au démarrage (SEC-01, SEC-23, SEC-07, SEC-13, SEC-15)', () => {
  it('accepte une configuration de production complète', () => {
    expect(problemsOf(productionEnv())).toEqual([]);
  });

  describe('SEC-01 — matrice NODE_ENV × AUTH_PROVIDER', () => {
    it.each([
      ['production', 'dev', true],
      ['production', undefined, true],
      ['production', 'keycloak', false],
      ['development', 'dev', false],
      ['development', 'keycloak', false],
      ['development', 'Dev', true],
      ['test', 'dev', false],
      ['test', undefined, true],
    ])('NODE_ENV=%s AUTH_PROVIDER=%s → refus=%s', (nodeEnv, provider, refused) => {
      const env =
        nodeEnv === 'production'
          ? productionEnv({ AUTH_PROVIDER: provider })
          : { NODE_ENV: nodeEnv, AUTH_PROVIDER: provider, DEV_JWT_SECRET: STRONG, ...devKeycloak };
      expect(problemsOf(env).length > 0).toBe(refused);
    });

    it('message explicite si AUTH_PROVIDER=dev en production', () => {
      expect(problemsOf(productionEnv({ AUTH_PROVIDER: 'dev' })).join('\n')).toMatch(/"keycloak" en production/);
    });

    it('développement : refuse DEV_JWT_SECRET absent, public (.env.example) ou trop court', () => {
      expect(problemsOf({ NODE_ENV: 'development', AUTH_PROVIDER: 'dev' }).join('\n')).toMatch(/DEV_JWT_SECRET est absent/);
      expect(problemsOf({ NODE_ENV: 'development', AUTH_PROVIDER: 'dev', DEV_JWT_SECRET: EXAMPLE_DEV_JWT_SECRET }).join('\n')).toMatch(/valeur PUBLIQUE/);
      expect(problemsOf({ NODE_ENV: 'development', AUTH_PROVIDER: 'dev', DEV_JWT_SECRET: 'court' }).join('\n')).toMatch(/au moins 32/);
    });

    it('getDevJwtSecret : aucune valeur de repli publique hors Jest, clé éphémère stable sous Jest', () => {
      expect(() => getDevJwtSecret({ NODE_ENV: 'development' })).toThrow(EnvValidationError);
      expect(() => getDevJwtSecret({ NODE_ENV: 'development', DEV_JWT_SECRET: EXAMPLE_DEV_JWT_SECRET })).toThrow(EnvValidationError);
      expect(getDevJwtSecret({ NODE_ENV: 'development', DEV_JWT_SECRET: STRONG })).toBe(STRONG);
      const ephemeral = getDevJwtSecret({ NODE_ENV: 'test', DEV_JWT_SECRET: EXAMPLE_DEV_JWT_SECRET });
      expect(ephemeral).not.toBe(EXAMPLE_DEV_JWT_SECRET);
      expect(ephemeral).toHaveLength(64);
      expect(getDevJwtSecret({ NODE_ENV: 'test' })).toBe(ephemeral);
    });

    it('Keycloak : configuration minimale exigée', () => {
      expect(problemsOf(productionEnv({ KEYCLOAK_REALM: undefined })).join('\n')).toMatch(/KEYCLOAK_REALM est obligatoire/);
    });
  });

  describe('SEC-23 — base de données et Redis', () => {
    it.each(['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'])('production : %s obligatoire (aucun repli)', (key) => {
      expect(problemsOf(productionEnv({ [key]: undefined })).join('\n')).toMatch(new RegExp(`${key} est obligatoire`));
    });

    it('production : refuse le mot de passe du docker-compose de développement', () => {
      expect(problemsOf(productionEnv({ DB_PASSWORD: 'ida_place' })).join('\n')).toMatch(/mot de passe de développement/);
    });

    it('DB_SSL_CA doit être un PEM ou un fichier existant ; booléens validés', () => {
      expect(problemsOf(productionEnv({ DB_SSL_CA: '/chemin/inexistant/ca.pem' })).join('\n')).toMatch(/DB_SSL_CA/);
      expect(problemsOf(productionEnv({ DB_SSL_CA: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----' }))).toEqual([]);
      expect(problemsOf(productionEnv({ DB_SSL: 'oui' })).join('\n')).toMatch(/DB_SSL doit valoir/);
    });

    it('production : Redis activé exige un mot de passe dans REDIS_URL', () => {
      expect(problemsOf(productionEnv({ REDIS_ENABLED: 'true', REDIS_URL: 'redis://cache:6379' })).join('\n')).toMatch(/mot de passe/);
      expect(problemsOf(productionEnv({ REDIS_ENABLED: 'true', REDIS_URL: 'rediss://:s3cret@cache:6380' }))).toEqual([]);
    });
  });

  describe('SEC-15 — clé HMAC du journal scellé', () => {
    it("production : obligatoire, longue, différente de la valeur d'exemple", () => {
      expect(problemsOf(productionEnv({ LEDGER_HMAC_KEY: undefined })).join('\n')).toMatch(/LEDGER_HMAC_KEY est obligatoire/);
      expect(problemsOf(productionEnv({ LEDGER_HMAC_KEY: EXAMPLE_LEDGER_HMAC_KEY })).join('\n')).toMatch(/valeur publique/);
      expect(() => getLedgerHmacKey({ NODE_ENV: 'production' })).toThrow(EnvValidationError);
    });

    it('hors production : valeur du .env, sinon clé éphémère signalée', () => {
      expect(getLedgerHmacKey({ NODE_ENV: 'development', LEDGER_HMAC_KEY: STRONG })).toEqual({ key: STRONG, ephemeral: false });
      expect(getLedgerHmacKey({ NODE_ENV: 'development' }).ephemeral).toBe(true);
    });
  });

  describe('SEC-07 — CORS', () => {
    it('refuse "*" (production et développement)', () => {
      expect(problemsOf(productionEnv({ CORS_ORIGIN: '*' })).join('\n')).toMatch(/"\*"/);
      expect(problemsOf({ NODE_ENV: 'development', AUTH_PROVIDER: 'keycloak', ...devKeycloak, CORS_ORIGIN: '*' }).length).toBeGreaterThan(0);
    });

    it('production : CORS_ORIGIN obligatoire et en https', () => {
      expect(problemsOf(productionEnv({ CORS_ORIGIN: undefined })).join('\n')).toMatch(/CORS_ORIGIN est obligatoire/);
      expect(problemsOf(productionEnv({ CORS_ORIGIN: 'http://ida-place.dz' })).join('\n')).toMatch(/https/);
    });

    it("accepte une liste d'origines séparées par des virgules", () => {
      expect(getCorsOrigins({ CORS_ORIGIN: 'https://a.dz, https://b.dz' })).toEqual(['https://a.dz', 'https://b.dz']);
      expect(getCorsOrigins({ NODE_ENV: 'development' })).toEqual(['http://localhost:3000']);
    });
  });

  describe('SEC-13 / SEC-41 — exposition', () => {
    it('limitation de débit : active par défaut, désactivée par défaut sous Jest, jamais désactivable en production', () => {
      expect(getThrottleSettings({ NODE_ENV: 'development' }).enabled).toBe(true);
      expect(getThrottleSettings({ NODE_ENV: 'test' }).enabled).toBe(false);
      expect(getThrottleSettings({ NODE_ENV: 'test', THROTTLE_ENABLED: 'true', THROTTLE_LIMIT: '5', THROTTLE_TTL_SECONDS: '10' })).toEqual({
        enabled: true,
        limit: 5,
        ttlMs: 10_000,
      });
      expect(getThrottleSettings({ NODE_ENV: 'production', THROTTLE_ENABLED: 'false' }).enabled).toBe(true);
      expect(problemsOf(productionEnv({ THROTTLE_ENABLED: 'false' })).join('\n')).toMatch(/interdit en production/);
    });

    it('TRUST_PROXY_HOPS : entier borné', () => {
      expect(problemsOf(productionEnv({ TRUST_PROXY_HOPS: '1' }))).toEqual([]);
      expect(problemsOf(productionEnv({ TRUST_PROXY_HOPS: 'true' })).join('\n')).toMatch(/TRUST_PROXY_HOPS/);
    });

    it('Swagger : désactivé en production sauf SWAGGER_ENABLED=true', () => {
      expect(isSwaggerEnabled({ NODE_ENV: 'production' })).toBe(false);
      expect(isSwaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' })).toBe(true);
      expect(isSwaggerEnabled({ NODE_ENV: 'development' })).toBe(true);
      expect(isSwaggerEnabled({ NODE_ENV: 'development', SWAGGER_ENABLED: 'false' })).toBe(false);
    });
  });

  it('collecte TOUS les problèmes en une seule erreur lisible', () => {
    const problems = problemsOf({ NODE_ENV: 'production', AUTH_PROVIDER: 'dev', CORS_ORIGIN: '*' });
    expect(problems.length).toBeGreaterThanOrEqual(6);
  });
});
