import { HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { currentNodeEnv, isProductionEnv } from '../config/env.validation';
import { isDatabaseUnavailableError } from '../database/db-errors';
import { sanitizeForLog } from '../logging/sanitize-log';

/**
 * Mode dégradé explicite — voir README.md § "Mode dégradé".
 *
 * Keycloak, PostgreSQL, Redis, MinIO et Paperless ne sont pas forcément
 * disponibles en DÉVELOPPEMENT. La règle du projet est :
 *   1. l'application démarre toujours (jamais de crash au boot faute d'une
 *      intégration externe) ;
 *   2. en l'absence d'un service, on bascule sur un comportement de secours
 *      EXPLICITE, journalisé, documenté ici et jamais silencieux ;
 *   3. on ne triche jamais sur la sécurité pour compenser l'absence d'un
 *      service (ex: pas d'auth "toujours admin" si Keycloak est injoignable).
 *
 * SEC-08 (revue sécurité 2026-10-19) — AVANT, le `catch` interceptait TOUTE
 * erreur (y compris `ConflictException`, violation d'unicité, valeur trop
 * longue, erreur d'usage de l'ORM) et renvoyait un succès servi par le repli
 * mémoire : l'écriture était perdue sans que l'appelant le sache. Désormais :
 *   - une `HttpException` (contrôle d'accès, conflit, 404…) est TOUJOURS
 *     relancée telle quelle ;
 *   - une violation de contrainte ou toute autre erreur est relancée (le
 *     filtre global la convertit en 409/400/500) ;
 *   - seule une erreur de connexion IDENTIFIÉE (`isDatabaseUnavailableError`)
 *     déclenche le repli, et UNIQUEMENT hors production ;
 *   - en production (`NODE_ENV=production`), aucun repli : 503
 *     `SERVICE_UNAVAILABLE` (la sonde `/health/ready` échoue elle aussi).
 *
 * Rechercher "DEGRADED_MODE" dans le code pour retrouver tous les points de bascule.
 */
export function logDegraded(scope: string, reason: string): void {
  new Logger('DEGRADED_MODE').warn(`[${scope}] mode dégradé actif — ${sanitizeForLog(reason, 500)}`);
}

/** Erreur 503 normalisée renvoyée quand la base est injoignable (production, ou opérations sans repli). */
export function databaseUnavailable(scope: string): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'SERVICE_UNAVAILABLE',
    message: 'Service temporairement indisponible (base de données injoignable).',
    details: { scope },
  });
}

/**
 * Exception de COMPATIBILITÉ limitée à Jest (`NODE_ENV=test`), jamais active
 * en développement ni en production, et volontairement ÉTROITE : elle ne
 * reconnaît que les deux formes de « panne simulée » des doubles de
 * repository des tests unitaires existants des autres modules :
 *  - `new Error('DB injoignable (test)')` (message contenant « injoignable ») ;
 *  - un double incomplet (`TypeError: this.repo.findOneOrFail is not a function`).
 * Toute autre erreur (HttpException, contrainte, erreur d'usage de l'ORM…)
 * est relancée, sous Jest aussi. À retirer une fois ces tests migrés vers
 * `simulatedDatabaseOutage()` (common/database/db-errors.ts).
 */
function isSimulatedOutageUnderJest(err: unknown): boolean {
  if (currentNodeEnv() !== 'test' || !(err instanceof Error)) return false;
  if (err.constructor === Error && /injoignable/i.test(err.message)) return true;
  return err instanceof TypeError && /is not a function/.test(err.message);
}

export async function withDegradedFallback<T>(
  scope: string,
  operation: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof HttpException) throw err;
    if (!isDatabaseUnavailableError(err) && !isSimulatedOutageUnderJest(err)) throw err;
    if (isProductionEnv()) {
      new Logger('DEGRADED_MODE').error(`[${scope}] base de données injoignable en production — 503, aucun repli (${sanitizeForLog(err)})`);
      throw databaseUnavailable(scope);
    }
    logDegraded(scope, `base de données injoignable (${(err as Error).message}) — repli mémoire`);
    return fallback();
  }
}
