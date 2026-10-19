import {
  ConnectionException,
  ConstraintViolationException,
  ForeignKeyConstraintViolationException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';

/**
 * SEC-08 — classification des erreurs de base de données.
 *
 * Le mode dégradé ne doit se déclencher QUE si la base est réellement
 * injoignable (refus de connexion, hôte introuvable, délai d'acquisition de
 * connexion dépassé, authentification refusée, base inexistante, serveur en
 * arrêt). Toute autre erreur (contrainte violée, valeur trop longue, table
 * absente, bogue applicatif, `HttpException`) doit remonter telle quelle.
 *
 * Formes observées avec MikroORM 6 + knex + pg (voir rapport SEC-08) :
 *  - `DriverException` avec `code = 'ECONNREFUSED'` (port fermé) ;
 *  - `DriverException` avec `code = '28P01'` (authentification refusée —
 *    cas des postes de dev où un autre PostgreSQL écoute sur 5432) ;
 *  - `DriverException` sans code, message « Knex: Timeout acquiring a
 *    connection » (hôte injoignable / DNS).
 */

/** Codes d'erreur système Node.js signifiant « serveur injoignable ». */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
]);

/**
 * SQLSTATE PostgreSQL signifiant « la base n'est pas utilisable » :
 * classe 08 (connexion), classe 28 (autorisation refusée), 3D000 (base
 * inexistante), 53300 (trop de connexions), 57P01-57P03 (arrêt/démarrage).
 */
function isUnavailableSqlState(code: string): boolean {
  return code.startsWith('08') || code.startsWith('28') || ['3D000', '53300', '57P01', '57P02', '57P03'].includes(code);
}

const TIMEOUT_MESSAGES = [/Timeout acquiring a connection/i, /Connection terminated unexpectedly/i, /connect ETIMEDOUT/i];

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  errors?: unknown;
}

export function isDatabaseUnavailableError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 4) return false;
  if (err instanceof ConnectionException) return true;
  const e = err as ErrorLike;
  if (e.name === 'KnexTimeoutError') return true;
  if (typeof e.code === 'string' && (NETWORK_ERROR_CODES.has(e.code) || isUnavailableSqlState(e.code))) return true;
  if (typeof e.message === 'string' && TIMEOUT_MESSAGES.some((re) => re.test(e.message as string))) return true;
  // AggregateError (Node ≥ 20, tentatives IPv4/IPv6) et erreurs chaînées.
  if (Array.isArray(e.errors) && e.errors.some((inner) => isDatabaseUnavailableError(inner, depth + 1))) return true;
  return isDatabaseUnavailableError(e.cause, depth + 1);
}

/**
 * Pour les tests : erreur reconnue comme « base injoignable » (même forme
 * qu'un refus de connexion réel du pilote pg). À utiliser dans les doubles de
 * repository plutôt qu'une `Error` générique.
 */
export function simulatedDatabaseOutage(message = 'connect ECONNREFUSED 127.0.0.1:5432 (simulé)'): Error {
  return Object.assign(new Error(message), { code: 'ECONNREFUSED' });
}

/** Violation de contrainte (unicité, clé étrangère, NOT NULL, CHECK). */
export function isConstraintViolation(err: unknown): err is ConstraintViolationException {
  return err instanceof ConstraintViolationException;
}

export function isUniqueOrForeignKeyViolation(err: unknown): boolean {
  return err instanceof UniqueConstraintViolationException || err instanceof ForeignKeyConstraintViolationException;
}

/** SQLSTATE classe 22 (« data exception » : valeur trop longue, format invalide…) — erreur de la requête, pas du serveur. */
export function isDataException(err: unknown): boolean {
  const code = (err as ErrorLike | undefined)?.code;
  return typeof code === 'string' && code.startsWith('22');
}
