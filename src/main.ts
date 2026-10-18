import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { NormalizedExceptionFilter } from './common/filters/normalized-exception.filter';

const API_PREFIX = process.env.API_PREFIX ?? 'api/v1';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Revue sécurité 2026-10-18 : en-têtes de sécurité par défaut (X-Content-
  // Type-Options, X-Frame-Options, Referrer-Policy, HSTS...) — aucun n'était
  // défini auparavant. CSP désactivée explicitement : Swagger UI (`/api/docs`,
  // chargé par ce même process) utilise des scripts/styles inline que la CSP
  // stricte par défaut de helmet bloquerait ; les autres en-têtes restent actifs.
  app.use(helmet({ contentSecurityPolicy: false }));

  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalFilters(new NormalizedExceptionFilter());
  app.enableCors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000', credentials: true });

  // En-tête de version — B.11.
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('X-API-Version', 'v1');
    next();
  });

  const config = new DocumentBuilder()
    .setTitle('IDA Place API')
    .setDescription(
      "API de la plateforme de place IDA Place (chambre de compensation). " +
        "Voir /home/user/docs/IDA_Place_Dossier_Technique.md pour la spécification complète. " +
        "Authentification DEV: en-tête 'x-dev-user' (voir DevAuthProvider).",
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('auth')
    .addTag('referential')
    .addTag('claims')
    .addTag('eligibility')
    .addTag('matching')
    .addTag('recours')
    .addTag('settlement')
    .addTag('commission')
    .addTag('monitoring')
    .addTag('fraud')
    .addTag('metering')
    .addTag('stats')
    .addTag('ledger')
    .addTag('admin')
    .addTag('documents')
    .addTag('cockpit')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`IDA Place API démarrée sur http://localhost:${port}/${API_PREFIX} (Swagger: /api/docs)`);
}

bootstrap();
