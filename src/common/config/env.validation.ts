import { randomBytes } from 'crypto';
import { existsSync } from 'fs';

/**
 * Validation de la configuration au démarrage — SEC-01, SEC-07, SEC-13,
 * SEC-15, SEC-23, SEC-41 (revue sécurité 2026-10-19).
 *
 * Validation maison (aucune dépendance lourde) : `validateEnv()` collecte
 * TOUTES les anomalies puis lève une seule `EnvValidationError` lisible. Elle
 * est exécutée à la compilation du module racine (`EnvValidationModule`),
 * donc avant que l'API n'accepte la moindre requête.
 *
 * Principe : en production, aucune valeur de repli pour un secret ou un
 * identifiant — le démarrage échoue si la variable manque ou vaut la valeur
 * publique de `.env.example`. Hors production, le mode développement
 * (`AUTH_PROVIDER=dev`, repli mémoire) reste utilisable.
 */

export type NodeEnv = 'development' | 'test' | 'production';
const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];

/** Valeur publique de `.env.example` (historique) : jamais acceptée hors tests. */
export const EXAMPLE_DEV_JWT_SECRET = 'dev-local-only-secret-change-me';
/** Valeur publique de `.env.example` : jamais acceptée en production. */
export const EXAMPLE_LEDGER_HMAC_KEY = 'dev-local-only-ledger-hmac-key-change-me-0000';
/** Mot de passe du `docker-compose.yml` de développement : jamais accepté en production. */
const DEV_DB_PASSWORD = 'ida_place';

const MIN_SECRET_LENGTH = 32;

export class EnvValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuration invalide — démarrage refusé :\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

type Env = Record<string, string | undefined>;

export function currentNodeEnv(env: Env = process.env): NodeEnv {
  return (NODE_ENVS as readonly string[]).includes(env.NODE_ENV ?? '') ? (env.NODE_ENV as NodeEnv) : 'development';
}

export function isProductionEnv(env: Env = process.env): boolean {
  return env.NODE_ENV === 'production';
}

function isBooleanString(v: string | undefined): boolean {
  return v === undefined || v === 'true' || v === 'false';
}

function isNonNegativeInt(v: string | undefined, max = Number.MAX_SAFE_INTEGER): boolean {
  return v === undefined || (/^\d+$/.test(v) && Number(v) <= max);
}

function isPositiveInt(v: string | undefined): boolean {
  return v === undefined || (/^\d+$/.test(v) && Number(v) > 0);
}

/** Liste des origines CORS autorisées (HTTP et WebSocket) — jamais `*`. */
export function getCorsOrigins(env: Env = process.env): string[] {
  const raw = env.CORS_ORIGIN?.trim();
  if (!raw) return isProductionEnv(env) ? [] : ['http://localhost:3000'];
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/** `trust proxy` Express : nombre de sauts de reverse proxy de confiance (0 = aucun). */
export function getTrustProxyHops(env: Env = process.env): number {
  return env.TRUST_PROXY_HOPS ? Number(env.TRUST_PROXY_HOPS) : 0;
}

export interface ThrottleSettings {
  enabled: boolean;
  ttlMs: number;
  limit: number;
}

/**
 * SEC-13 — limitation de débit globale. Par défaut 300 requêtes / 60 s par
 * adresse IP cliente (voir `TRUST_PROXY_HOPS`). Désactivée par défaut sous
 * Jest (`NODE_ENV=test`) pour ne pas fausser les suites e2e, réactivable par
 * `THROTTLE_ENABLED=true` ; ne peut pas être désactivée en production.
 */
export function getThrottleSettings(env: Env = process.env): ThrottleSettings {
  const nodeEnv = currentNodeEnv(env);
  const enabled = env.THROTTLE_ENABLED !== undefined ? env.THROTTLE_ENABLED === 'true' : nodeEnv !== 'test';
  return {
    enabled: nodeEnv === 'production' ? true : enabled,
    ttlMs: Number(env.THROTTLE_TTL_SECONDS ?? 60) * 1000,
    limit: Number(env.THROTTLE_LIMIT ?? 300),
  };
}

/** SEC-41 — Swagger : désactivé en production sauf `SWAGGER_ENABLED=true` ; activé ailleurs sauf `SWAGGER_ENABLED=false`. */
export function isSwaggerEnabled(env: Env = process.env): boolean {
  if (env.SWAGGER_ENABLED !== undefined) return env.SWAGGER_ENABLED === 'true';
  return !isProductionEnv(env);
}

/**
 * Secrets éphémères générés UNIQUEMENT sous Jest (`NODE_ENV=test`) quand la
 * variable est absente ou vaut la valeur d'exemple : les suites de tests
 * tournent ainsi avec n'importe quel `.env` de poste, sans jamais accepter
 * un secret public en développement ou en production.
 */
const ephemeralSecrets = new Map<string, string>();
function ephemeral(name: string): string {
  let value = ephemeralSecrets.get(name);
  if (!value) {
    value = randomBytes(32).toString('hex');
    ephemeralSecrets.set(name, value);
  }
  return value;
}

/** SEC-01 — secret de signature des jetons du `DevAuthProvider` (aucun repli public). */
export function getDevJwtSecret(env: Env = process.env): string {
  const value = env.DEV_JWT_SECRET;
  if (value && value !== EXAMPLE_DEV_JWT_SECRET && value.length >= MIN_SECRET_LENGTH) return value;
  if (currentNodeEnv(env) === 'test') return ephemeral('DEV_JWT_SECRET');
  throw new EnvValidationError([devJwtSecretProblem(value)]);
}

function devJwtSecretProblem(value: string | undefined): string {
  if (!value) return 'DEV_JWT_SECRET est absent alors que AUTH_PROVIDER=dev (aucune valeur de repli).';
  if (value === EXAMPLE_DEV_JWT_SECRET) {
    return 'DEV_JWT_SECRET vaut la valeur PUBLIQUE de .env.example : générer un secret local (ex. `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"`).';
  }
  return `DEV_JWT_SECRET doit faire au moins ${MIN_SECRET_LENGTH} caractères.`;
}

/**
 * SEC-15 — clé HMAC du journal scellé. Obligatoire en production (hors base,
 * coffre de secrets). Hors production : valeur du `.env` si présente, sinon
 * clé éphémère par processus (avertissement : les entrées écrites dans une
 * vraie base ne seront plus vérifiables après redémarrage).
 */
export function getLedgerHmacKey(env: Env = process.env): { key: string; ephemeral: boolean } {
  const value = env.LEDGER_HMAC_KEY;
  if (isProductionEnv(env)) {
    if (!value || value === EXAMPLE_LEDGER_HMAC_KEY || value.length < MIN_SECRET_LENGTH) {
      throw new EnvValidationError([ledgerKeyProblem(value)]);
    }
    return { key: value, ephemeral: false };
  }
  if (value && value.length >= MIN_SECRET_LENGTH) return { key: value, ephemeral: false };
  return { key: ephemeral('LEDGER_HMAC_KEY'), ephemeral: true };
}

function ledgerKeyProblem(value: string | undefined): string {
  if (!value) return 'LEDGER_HMAC_KEY est obligatoire en production (clé HMAC du journal scellé, hors base).';
  if (value === EXAMPLE_LEDGER_HMAC_KEY) return 'LEDGER_HMAC_KEY vaut la valeur publique de .env.example.';
  return `LEDGER_HMAC_KEY doit faire au moins ${MIN_SECRET_LENGTH} caractères.`;
}

export interface EnvValidationResult {
  nodeEnv: NodeEnv;
  authProvider: 'dev' | 'keycloak';
  warnings: string[];
}

/**
 * Valide l'ensemble de la configuration. Lève `EnvValidationError` (liste
 * complète des problèmes) si la configuration est inacceptable ; renvoie les
 * avertissements non bloquants sinon.
 */
export function validateEnv(env: Env = process.env): EnvValidationResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const prod = isProductionEnv(env);

  if (env.NODE_ENV !== undefined && !(NODE_ENVS as readonly string[]).includes(env.NODE_ENV)) {
    problems.push(`NODE_ENV doit valoir ${NODE_ENVS.join(' | ')} (valeur actuelle : ${JSON.stringify(env.NODE_ENV)}).`);
  }
  const nodeEnv = currentNodeEnv(env);

  // --- Authentification (SEC-01) ---
  const authProvider = env.AUTH_PROVIDER;
  if (authProvider !== 'dev' && authProvider !== 'keycloak') {
    problems.push(
      `AUTH_PROVIDER doit valoir "dev" ou "keycloak" (valeur actuelle: ${JSON.stringify(authProvider ?? null)}). Aucun repli implicite sur DevAuthProvider.`,
    );
  }
  if (prod && authProvider !== 'keycloak') {
    problems.push('AUTH_PROVIDER doit valoir "keycloak" en production : le fournisseur de développement (en-tête x-dev-user) y est interdit.');
  }
  if (authProvider === 'keycloak') {
    for (const k of ['KEYCLOAK_BASE_URL', 'KEYCLOAK_REALM', 'KEYCLOAK_CLIENT_ID']) {
      if (!env[k]) problems.push(`${k} est obligatoire quand AUTH_PROVIDER=keycloak.`);
    }
    if (env.KEYCLOAK_BASE_URL && !/^https?:\/\//.test(env.KEYCLOAK_BASE_URL)) {
      problems.push('KEYCLOAK_BASE_URL doit être une URL http(s).');
    }
  }
  if (authProvider === 'dev' && !prod && nodeEnv !== 'test') {
    const v = env.DEV_JWT_SECRET;
    if (!v || v === EXAMPLE_DEV_JWT_SECRET || v.length < MIN_SECRET_LENGTH) problems.push(devJwtSecretProblem(v));
  }

  // --- Base de données (SEC-23) ---
  if (prod) {
    for (const k of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
      if (!env[k]) problems.push(`${k} est obligatoire en production (aucune valeur de repli).`);
    }
    if (env.DB_PASSWORD && env.DB_PASSWORD === DEV_DB_PASSWORD) {
      problems.push('DB_PASSWORD vaut le mot de passe de développement du docker-compose : interdit en production.');
    }
    if (env.DB_SSL === 'false') warnings.push('DB_SSL=false en production : le trafic PostgreSQL circule en clair (réseau privé obligatoire).');
  }
  if (!isNonNegativeInt(env.DB_PORT, 65535)) problems.push('DB_PORT doit être un numéro de port.');
  for (const k of ['DB_SSL', 'DB_SSL_REJECT_UNAUTHORIZED', 'DB_DEBUG']) {
    if (!isBooleanString(env[k])) problems.push(`${k} doit valoir "true" ou "false".`);
  }
  if (env.DB_SSL_CA && !env.DB_SSL_CA.includes('-----BEGIN') && !existsSync(env.DB_SSL_CA)) {
    problems.push('DB_SSL_CA doit être un certificat PEM ou le chemin d\'un fichier existant.');
  }

  // --- Journal scellé (SEC-15) ---
  if (prod) {
    const v = env.LEDGER_HMAC_KEY;
    if (!v || v === EXAMPLE_LEDGER_HMAC_KEY || v.length < MIN_SECRET_LENGTH) problems.push(ledgerKeyProblem(v));
  } else if (!env.LEDGER_HMAC_KEY && nodeEnv !== 'test') {
    warnings.push('LEDGER_HMAC_KEY absent : clé HMAC éphémère pour ce processus (journal non vérifiable après redémarrage si persisté).');
  }

  // --- CORS HTTP et WebSocket (SEC-07) ---
  const origins = getCorsOrigins(env);
  if (prod && origins.length === 0) problems.push('CORS_ORIGIN est obligatoire en production (origine(s) du frontend).');
  for (const o of origins) {
    if (o === '*' || o.includes('*')) {
      problems.push('CORS_ORIGIN ne peut pas contenir "*" (origine(s) explicite(s) uniquement).');
      continue;
    }
    let url: URL | undefined;
    try {
      url = new URL(o);
    } catch {
      problems.push(`CORS_ORIGIN contient une origine invalide : ${JSON.stringify(o)}.`);
      continue;
    }
    if (prod && url.protocol !== 'https:') problems.push(`CORS_ORIGIN doit être en https en production (${o}).`);
  }

  // --- Exposition Internet (SEC-13, SEC-41) ---
  if (!isNonNegativeInt(env.TRUST_PROXY_HOPS, 10)) problems.push('TRUST_PROXY_HOPS doit être un entier entre 0 et 10.');
  for (const k of ['THROTTLE_ENABLED', 'SWAGGER_ENABLED', 'REDIS_ENABLED', 'LOG_JSON']) {
    if (!isBooleanString(env[k])) problems.push(`${k} doit valoir "true" ou "false".`);
  }
  if (!isPositiveInt(env.THROTTLE_TTL_SECONDS)) problems.push('THROTTLE_TTL_SECONDS doit être un entier > 0.');
  if (!isPositiveInt(env.THROTTLE_LIMIT)) problems.push('THROTTLE_LIMIT doit être un entier > 0.');
  if (prod && env.THROTTLE_ENABLED === 'false') problems.push('THROTTLE_ENABLED=false est interdit en production.');
  if (prod && env.SWAGGER_ENABLED === 'true') warnings.push('SWAGGER_ENABLED=true en production : la cartographie de l\'API est publique.');

  // --- Redis (SEC-23) ---
  if (prod && env.REDIS_ENABLED === 'true') {
    let password = '';
    try {
      password = env.REDIS_URL ? decodeURIComponent(new URL(env.REDIS_URL).password) : '';
    } catch {
      problems.push('REDIS_URL invalide.');
    }
    if (!env.REDIS_URL) problems.push('REDIS_URL est obligatoire en production quand REDIS_ENABLED=true.');
    else if (!password) problems.push('REDIS_URL doit porter un mot de passe en production (redis://:motdepasse@hôte:6379 ou rediss://…).');
  }

  if (problems.length > 0) throw new EnvValidationError(problems);
  return { nodeEnv, authProvider: authProvider as 'dev' | 'keycloak', warnings };
}
