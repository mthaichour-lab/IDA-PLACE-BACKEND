import { ConstraintViolationException, DeadlockException, LockWaitTimeoutException, OptimisticLockError, UniqueConstraintViolationException } from '@mikro-orm/core';
import { ConflictException, HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { logDegraded } from '../common/interfaces/degraded-mode';

/**
 * Persistance stricte des écritures financières et disciplinaires (recours,
 * clôtures, commission, adhésions) — SEC-08/SEC-19/SEC-33.
 *
 * Contrairement à `withDegradedFallback` (lectures), une écriture ne bascule
 * JAMAIS en mémoire :
 *  - sur une erreur MÉTIER (`HttpException`), une violation de contrainte
 *    (unicité, CHECK…), un conflit de version ou un verrou : l'erreur est
 *    relancée (409 pour les conflits, voir `toConflict`) ;
 *  - en production (`NODE_ENV=production`) : base indisponible = 503,
 *    jamais un succès fictif.
 * Le repli mémoire n'existe plus qu'en développement/test, où toute
 * l'application tourne explicitement en mode dégradé sans PostgreSQL
 * (`mikro-orm.config.ts`, `connect: false`).
 */
export function degradedWritesAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof UniqueConstraintViolationException || (err as { code?: string } | undefined)?.code === '23505';
}

function isConcurrencyError(err: unknown): boolean {
  return err instanceof OptimisticLockError || err instanceof DeadlockException || err instanceof LockWaitTimeoutException;
}

/** Erreurs qui ne signifient PAS « base injoignable » : jamais de repli. */
export function isNonFallbackError(err: unknown): boolean {
  return err instanceof HttpException || err instanceof ConstraintViolationException || isConcurrencyError(err);
}

/** Traduit une violation d'unicité ou un conflit de version en 409 ; relance le reste tel quel. */
export function toConflict(err: unknown, code: string, message: string): unknown {
  if (isUniqueViolation(err) || isConcurrencyError(err)) return new ConflictException({ code, message });
  return err;
}

const logger = new Logger('StrictPersistence');

/**
 * Exécute `operation` (base de données) ; si la base est injoignable, exécute
 * `fallback` (mémoire) en développement uniquement, 503 en production.
 */
export async function withStrictFallback<T>(scope: string, operation: () => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (isNonFallbackError(err)) throw err;
    if (!degradedWritesAllowed()) {
      logger.error(`[${scope}] base de données indisponible — écriture refusée (${(err as Error).message})`);
      throw new ServiceUnavailableException({ code: 'SERVICE_INDISPONIBLE', message: 'Service momentanément indisponible.' });
    }
    logDegraded(scope, `base de données injoignable (${(err as Error).message}) — repli mémoire (hors production)`);
    return fallback();
  }
}
