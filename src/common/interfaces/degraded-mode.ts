import { Logger } from '@nestjs/common';

/**
 * Mode dégradé explicite — voir README.md § "Mode dégradé".
 *
 * Keycloak, PostgreSQL, Redis, MinIO et Paperless ne sont pas forcément
 * disponibles dans cet environnement. La règle du projet est :
 *   1. l'application démarre toujours (jamais de crash au boot faute d'une
 *      intégration externe) ;
 *   2. en l'absence d'un service, on bascule sur un comportement de secours
 *      EXPLICITE, journalisé, documenté ici et jamais silencieux ;
 *   3. on ne triche jamais sur la sécurité pour compenser l'absence d'un
 *      service (ex: pas d'auth "toujours admin" si Keycloak est injoignable).
 *
 * Ce helper uniformise le logging de ce mode dégradé et sert de point
 * d'extension unique pour le futur agent Backend (recherche "DEGRADED_MODE"
 * dans le code pour retrouver tous les points de bascule).
 */
export function logDegraded(scope: string, reason: string): void {
  new Logger('DEGRADED_MODE').warn(`[${scope}] mode dégradé actif — ${reason}`);
}

export async function withDegradedFallback<T>(
  scope: string,
  operation: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    logDegraded(scope, `base de données injoignable (${(err as Error).message}) — repli mémoire`);
    return fallback();
  }
}
