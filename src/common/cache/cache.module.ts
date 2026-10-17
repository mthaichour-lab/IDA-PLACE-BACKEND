import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';

/**
 * CacheModule — infrastructure transverse (cache de lecture Redis, flag
 * `REDIS_ENABLED`). `@Global()` : même pattern que `AuthModule` (B.2) —
 * un seul enregistrement dans `AppModule`, disponible partout sans import
 * explicite. Voir `cache.service.ts` pour le détail du repli no-op.
 */
@Global()
@Module({ providers: [CacheService], exports: [CacheService] })
export class CacheModule {}
