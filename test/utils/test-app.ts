import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/common/bootstrap/configure-app';

/**
 * Bootstrap d'une application Nest pour les tests e2e (Supertest), avec
 * EXACTEMENT la configuration de `src/main.ts` : `configureApp()` (préfixe
 * `/api/v1`, ValidationPipe, NormalizedExceptionFilter, helmet, limite de
 * corps, query parser `simple`, CORS, adaptateur WebSocket, Swagger selon
 * l'environnement) — pour que ces tests exercent le même comportement que
 * l'application réellement démarrée.
 *
 * Fonctionne sans PostgreSQL/Redis réels (mode dégradé hors production, voir
 * `mikro-orm.config.ts` : `connect: false`). La limitation de débit est
 * désactivée par défaut sous Jest (`THROTTLE_ENABLED=true` pour la tester).
 */
export async function createTestApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.init();
  return app;
}
