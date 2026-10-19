import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { RealtimeIoAdapter } from '../../realtime/realtime-io.adapter';
import { getCorsOrigins, getTrustProxyHops, isProductionEnv, isSwaggerEnabled } from '../config/env.validation';
import { NormalizedExceptionFilter } from '../filters/normalized-exception.filter';

export const API_DOCS_PATH = 'api/docs';
/** SEC-13 — taille maximale d'un corps JSON / urlencoded (les imports de fichiers passent par multer, bornés par leurs modules). */
export const BODY_SIZE_LIMIT = '1mb';

/**
 * Erreurs du body-parser (JSON invalide, corps trop gros, encodage non
 * supporté) — SEC-45 : elles surviennent AVANT le routage Nest, donc hors de
 * portée de `NormalizedExceptionFilter`. Converties ici en réponse normalisée
 * `{code, message}` avec le bon statut (400/413/415), sans écho du contenu
 * reçu ni pile d'appel.
 */
export function bodyParserErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const e = err as { type?: string; status?: number; statusCode?: number } | undefined;
  const status = e?.status ?? e?.statusCode;
  if (!e || typeof e.type !== 'string' || typeof status !== 'number' || status < 400 || status >= 500) {
    next(err);
    return;
  }
  if (e.type === 'entity.too.large') {
    res.status(HttpStatus.PAYLOAD_TOO_LARGE).json({ code: 'PAYLOAD_TOO_LARGE', message: `Corps de requête trop volumineux (maximum ${BODY_SIZE_LIMIT}).` });
    return;
  }
  if (e.type === 'entity.parse.failed') {
    res.status(HttpStatus.BAD_REQUEST).json({ code: 'BAD_REQUEST', message: 'Corps de requête illisible (JSON invalide).' });
    return;
  }
  res.status(status).json({ code: status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'BAD_REQUEST', message: 'Corps de requête refusé.' });
}

function isDocsPath(path: string): boolean {
  return path === `/${API_DOCS_PATH}` || path.startsWith(`/${API_DOCS_PATH}/`) || path.startsWith(`/${API_DOCS_PATH}-json`) || path.startsWith(`/${API_DOCS_PATH}-yaml`);
}

/**
 * Configuration HTTP commune à `main.ts` et aux tests e2e (`test/utils/test-app.ts`),
 * pour que les tests exercent exactement l'application démarrée.
 *
 * L'application doit avoir été créée avec `{ bodyParser: false }` : les
 * analyseurs de corps sont enregistrés ici, avec leur limite.
 *
 * Socle sécurité (revue 2026-10-19) :
 *  - SEC-44 : `query parser` `simple` (aucun objet imbriqué dans la query
 *    string : `?companyId[$ne]=X` reste une clé littérale, jamais un opérateur) ;
 *  - SEC-13 : `trust proxy` = `TRUST_PROXY_HOPS` (adresse cliente réelle pour
 *    la limitation de débit), corps limité à 1 Mo ;
 *  - SEC-41 : CSP helmet active partout SAUF sous `/api/docs` ; Swagger non
 *    monté en production (sauf `SWAGGER_ENABLED=true`) ;
 *  - SEC-45 : erreurs d'analyse du corps → 400/413 normalisés ;
 *  - SEC-07 : CORS HTTP et WebSocket limités à `CORS_ORIGIN` (jamais `*`).
 */
export function configureApp(app: NestExpressApplication): { swaggerEnabled: boolean; apiPrefix: string } {
  const apiPrefix = process.env.API_PREFIX ?? 'api/v1';
  const corsOrigins = getCorsOrigins();

  app.set('query parser', 'simple');
  app.set('trust proxy', getTrustProxyHops());
  app.disable('x-powered-by');

  const strictHelmet = helmet();
  const docsHelmet = helmet({ contentSecurityPolicy: false });
  app.use((req: Request, res: Response, next: NextFunction) => (isDocsPath(req.path) ? docsHelmet : strictHelmet)(req, res, next));

  app.useBodyParser('json', { limit: BODY_SIZE_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_SIZE_LIMIT, extended: false });
  app.use(bodyParserErrorHandler);

  app.setGlobalPrefix(apiPrefix);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalFilters(new NormalizedExceptionFilter());
  app.enableCors({ origin: corsOrigins, credentials: true });
  app.useWebSocketAdapter(new RealtimeIoAdapter(app, corsOrigins));

  // En-tête de version — B.11.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-API-Version', 'v1');
    next();
  });

  const swaggerEnabled = isSwaggerEnabled();
  if (swaggerEnabled) {
    const devAuth = !isProductionEnv() && process.env.AUTH_PROVIDER === 'dev';
    const config = new DocumentBuilder()
      .setTitle('IDA Place API')
      .setDescription(
        'API de la plateforme de place IDA Place (chambre de compensation). ' +
          (devAuth ? "Authentification DEV : en-tête 'x-dev-user' (voir DevAuthProvider)." : 'Authentification : jeton Bearer Keycloak.'),
      )
      .setVersion('1.0')
      .addBearerAuth()
      .addTag('auth')
      .addTag('health')
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
    SwaggerModule.setup(API_DOCS_PATH, app, document);
  }

  return { swaggerEnabled, apiPrefix };
}
