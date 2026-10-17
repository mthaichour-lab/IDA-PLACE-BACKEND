import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { logDegraded } from '../interfaces/degraded-mode';

/**
 * CacheService — cache Redis minimal (flag `REDIS_ENABLED`), avec repli
 * no-op EXPLICITE si désactivé ou indisponible — même philosophie que le
 * reste du projet (voir README "Mode dégradé") : jamais une erreur Redis
 * ne doit faire échouer une requête API, elle recalcule simplement la
 * valeur sans cache.
 *
 * Référence réutilisable : branché sur `GET /cockpit/summary`
 * (`CockpitModule`, voir cockpit.module.ts) comme exemple ; pour étendre à
 * un autre endpoint, injecter `CacheService` (module `@Global()`, pas
 * besoin de l'importer explicitement) et envelopper le calcul :
 *
 * ```ts
 * return this.cache.getOrSet('ma:cle', 30, () => this.computeExpensiveThing());
 * ```
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger('CacheService');
  private readonly client?: Redis;
  private readonly enabled: boolean;

  constructor() {
    this.enabled = process.env.REDIS_ENABLED === 'true';
    if (!this.enabled) {
      logDegraded('CacheService', 'REDIS_ENABLED=false — cache de lecture désactivé (repli no-op explicite).');
      return;
    }

    try {
      this.client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        lazyConnect: false,
        enableOfflineQueue: false, // les commandes échouent immédiatement si non connecté (plutôt que de bloquer la requête).
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
      });
      this.client.on('error', (err) => {
        // Écouteur obligatoire : sans lui, une erreur de connexion Redis
        // fait planter le process Node (événement 'error' non géré).
        logDegraded('CacheService', `erreur Redis (${err.message}) — repli no-op pour les appels en cours.`);
      });
    } catch (err) {
      logDegraded('CacheService', `Redis indisponible à l'initialisation (${(err as Error).message}) — repli no-op.`);
      this.client = undefined;
    }
  }

  /** Lit `key` dans Redis ; si absent/indisponible, calcule via `factory()` et tente d'écrire le résultat (TTL `ttlSeconds`). */
  async getOrSet<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    if (!this.client) return factory();

    try {
      const cached = await this.client.get(key);
      if (cached !== null) return JSON.parse(cached) as T;
    } catch (err) {
      logDegraded('CacheService.getOrSet', `lecture cache impossible (${(err as Error).message}) — calcul direct.`);
      return factory();
    }

    const value = await factory();
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`Écriture cache impossible pour "${key}" (${(err as Error).message}) — valeur recalculée à chaque appel.`);
    }
    return value;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.quit().catch(() => undefined);
  }
}
