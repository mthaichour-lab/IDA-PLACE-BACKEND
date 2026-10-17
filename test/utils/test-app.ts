import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { NormalizedExceptionFilter } from '../../src/common/filters/normalized-exception.filter';

/**
 * Bootstrap d'une application Nest pour les tests e2e (Supertest), avec
 * exactement la même configuration globale que `src/main.ts` (ValidationPipe
 * whitelist/transform, NormalizedExceptionFilter, préfixe `/api/v1`) — pour
 * que ces tests exercent le même comportement que l'application réellement
 * démarrée (`npm run start:dev`).
 *
 * Fonctionne sans PostgreSQL/Redis réels (mode dégradé, voir
 * `mikro-orm.config.ts` : `connect: false`) — exactement comme l'application
 * démarrée dans cet environnement de développement.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalFilters(new NormalizedExceptionFilter());
  await app.init();
  return app;
}
