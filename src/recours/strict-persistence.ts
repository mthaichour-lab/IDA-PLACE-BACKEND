import { DeadlockException, LockWaitTimeoutException, OptimisticLockError, UniqueConstraintViolationException } from '@mikro-orm/core';
import { ConflictException } from '@nestjs/common';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';

/**
 * Persistance des écritures financières et disciplinaires (recours, clôtures,
 * commission, adhésions) — SEC-08/SEC-19/SEC-33.
 *
 * S'appuie sur `withDegradedFallback` (socle, SEC-08) : une erreur métier
 * (`HttpException`), une violation de contrainte, un conflit de version ou un
 * verrou ne déclenchent JAMAIS de repli ; seule une panne de connexion
 * identifiée le fait, et en production elle donne un 503 — jamais un succès
 * fictif en mémoire. Le repli mémoire ne subsiste qu'en développement/test,
 * où toute l'application tourne explicitement sans PostgreSQL.
 */
export const withStrictFallback = withDegradedFallback;

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof UniqueConstraintViolationException || (err as { code?: string } | undefined)?.code === '23505';
}

function isConcurrencyError(err: unknown): boolean {
  return err instanceof OptimisticLockError || err instanceof DeadlockException || err instanceof LockWaitTimeoutException;
}

/** Traduit une violation d'unicité ou un conflit de version en 409 ; relance le reste tel quel. */
export function toConflict(err: unknown, code: string, message: string): unknown {
  if (isUniqueViolation(err) || isConcurrencyError(err)) return new ConflictException({ code, message });
  return err;
}
