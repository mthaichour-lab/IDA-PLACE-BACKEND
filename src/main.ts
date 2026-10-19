import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './common/bootstrap/configure-app';
import { isProductionEnv } from './common/config/env.validation';

/**
 * SEC-45 : journaux structurés JSON (une entrée = une ligne, caractères de
 * contrôle échappés) par défaut en production, ou si `LOG_JSON=true`.
 */
function buildLogger(): ConsoleLogger {
  const json = process.env.LOG_JSON !== undefined ? process.env.LOG_JSON === 'true' : isProductionEnv();
  return new ConsoleLogger({ json, colors: !json });
}

async function bootstrap() {
  // `bodyParser: false` : les analyseurs de corps (limite 1 Mo) sont posés par `configureApp`.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger: buildLogger() });
  const { swaggerEnabled, apiPrefix } = configureApp(app);
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  new Logger('Bootstrap').log(
    `IDA Place API démarrée sur le port ${port} (/${apiPrefix})${swaggerEnabled ? ' — Swagger : /api/docs' : ' — Swagger désactivé'}`,
  );
}

bootstrap().catch((err: unknown) => {
  // Configuration invalide (EnvValidationError…) : message explicite, code de sortie non nul.
  // eslint-disable-next-line no-console
  console.error((err as Error)?.message ?? err);
  process.exit(1);
});
