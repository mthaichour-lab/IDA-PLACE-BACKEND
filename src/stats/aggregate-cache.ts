import { CacheService } from '../common/cache/cache.service';

/**
 * SEC-13 — agrégats coûteux (statistiques, monitoring, cockpit) : cache
 * existant (`CacheService`, Redis si `REDIS_ENABLED=true`) + protection
 * contre l'effet de troupeau dans le process : des appels simultanés pour
 * la même clé partagent UN seul calcul en cours (aucune donnée gardée après
 * la fin du calcul, donc jamais de valeur périmée sans Redis).
 *
 * La clé doit inclure le périmètre quand le résultat en dépend ; les
 * agrégats mis en cache ici sont place-entière, la projection par tenant
 * est appliquée APRÈS lecture du cache.
 */
export class AggregateCache {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly cache?: Pick<CacheService, 'getOrSet'>) {}

  get<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const promise = (this.cache ? this.cache.getOrSet(key, ttlSeconds, factory) : factory()).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}
