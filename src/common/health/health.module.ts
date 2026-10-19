import { MikroORM } from '@mikro-orm/core';
import { Controller, Get, HttpCode, Logger, Module, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sanitizeForLog } from '../logging/sanitize-log';

/** Délai maximal de la vérification de base pour la sonde de disponibilité. */
const READINESS_DB_TIMEOUT_MS = 2000;

/**
 * Sondes d'exploitation — SEC-08 (revue sécurité 2026-10-19).
 *
 *  - `GET /api/v1/health/live` : le processus répond (liveness). Ne dépend
 *    d'aucun service externe.
 *  - `GET /api/v1/health/ready` : l'API peut servir des requêtes
 *    (readiness) — échoue en 503 si PostgreSQL est injoignable, y compris
 *    hors production (le repli mémoire de développement n'est pas un état
 *    « prêt »).
 *
 * Non authentifiées (consommées par l'orchestrateur / le reverse proxy), et
 * volontairement pauvres en information : aucun message d'erreur interne
 * n'est renvoyé, seulement l'état. Exclues de la limitation de débit.
 */
@ApiTags('health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  private readonly logger = new Logger('Health');

  constructor(private readonly orm: MikroORM) {}

  @Get('live')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sonde de vie (le processus répond)' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sonde de disponibilité (échoue en 503 si la base est injoignable)' })
  async ready(): Promise<{ status: 'ok'; database: 'up' }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ ok: false; reason: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: `délai de ${READINESS_DB_TIMEOUT_MS} ms dépassé` }), READINESS_DB_TIMEOUT_MS);
    });
    try {
      const check = await Promise.race([
        this.orm.checkConnection().catch((err: unknown) => ({ ok: false as const, reason: (err as Error).message })),
        timeout,
      ]);
      if (!check.ok) {
        this.logger.warn(`Sonde ready en échec : base injoignable (${sanitizeForLog((check as { reason?: string }).reason ?? '')})`);
        throw new ServiceUnavailableException({ code: 'SERVICE_UNAVAILABLE', message: 'Base de données injoignable.', details: { database: 'down' } });
      }
      return { status: 'ok', database: 'up' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
