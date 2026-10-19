import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AUTHENTICATED_KEY, IS_PUBLIC_KEY } from '../src/common/decorators/access.decorator';
import { PRIVILEGES_KEY } from '../src/common/decorators/privileges.decorator';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { createTestApp } from './utils/test-app';

/**
 * SEC-43 — garde fermée par défaut : découverte de TOUTES les routes HTTP
 * enregistrées (DiscoveryService + MetadataScanner) et contrôle de leurs
 * déclarations d'accès.
 *
 *  - chaque handler déclare `@Privileges`, `@Roles`, `@Authenticated` ou `@Public` ;
 *  - aucune écriture (POST/PUT/PATCH/DELETE) n'est ouverte par le seul `@Authenticated` ;
 *  - les routes publiques et les routes « tout utilisateur authentifié » sont
 *    figées dans des listes REVUES ci-dessous : en ajouter une impose de
 *    mettre à jour ce test, donc une relecture explicite.
 */

interface RouteInfo {
  route: string;
  method: string;
  privileges: string[];
  roles: string[];
  authenticated: boolean;
  isPublic: boolean;
}

function joinPath(...parts: (string | string[] | undefined)[]): string {
  const segs = parts
    .map((p) => (Array.isArray(p) ? p[0] : p) ?? '')
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0);
  return '/' + segs.join('/');
}

function discoverRoutes(moduleRef: TestingModule): RouteInfo[] {
  const discovery = moduleRef.get(DiscoveryService);
  const scanner = moduleRef.get(MetadataScanner);
  const reflector = moduleRef.get(Reflector);
  const routes: RouteInfo[] = [];
  for (const wrapper of discovery.getControllers()) {
    const ctrl = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined;
    if (!ctrl) continue;
    const prefix = Reflect.getMetadata(PATH_METADATA, ctrl) as string | string[] | undefined;
    for (const name of scanner.getAllMethodNames(ctrl.prototype)) {
      const handler = (ctrl.prototype as Record<string, unknown>)[name] as (...args: unknown[]) => unknown;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (path === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      const targets = [handler, ctrl];
      routes.push({
        route: `${method} ${joinPath(prefix, path)}`,
        method,
        privileges: reflector.getAllAndOverride<string[]>(PRIVILEGES_KEY, targets) ?? [],
        roles: reflector.getAllAndOverride<string[]>(ROLES_KEY, targets) ?? [],
        authenticated: reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, targets) === true,
        isPublic: reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true,
      });
    }
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

/** Seules routes sans authentification : sondes de l'orchestrateur. */
const REVIEWED_PUBLIC_ROUTES = ['GET /health/live', 'GET /health/ready'];

/**
 * Routes ouvertes à tout utilisateur authentifié (`@Authenticated()` seul) —
 * revue SEC-43 du 2026-10-20. Le cloisonnement est fait par le service ou la
 * donnée est un référentiel commun ; la justification figure en commentaire
 * sur chaque route.
 */
const REVIEWED_AUTHENTICATED_ONLY_ROUTES = [
  'GET /claims',
  'GET /claims/:id',
  'GET /claims/import/columns',
  'GET /claims/import/columns/v2',
  'GET /commission/cases',
  'GET /commission/cases/:id',
  'GET /commission/membership-requests',
  'GET /commission/membership-requests/:id',
  'GET /commission/sanctions',
  'GET /commission/summary',
  'GET /documents/:id',
  'GET /documents/:id/download',
  'GET /eligibility/rules',
  'GET /fraud/adherents/:company/signals',
  'GET /fraud/cases',
  'GET /matching/:id',
  'GET /matching/:id/decisions',
  'GET /matching/queue',
  'GET /matching/queue/counters',
  'GET /matching/thresholds',
  'GET /me',
  'GET /metering/:company/:period',
  'GET /metering/:company/:period/history/:metric',
  'GET /monitoring/companies/:code/journeys',
  'GET /monitoring/scores',
  'GET /monitoring/trajectories',
  'GET /pricing/grid',
  'GET /recours',
  'GET /recours/:id',
  'GET /recours/:id/history',
  'GET /recours/counters',
  'GET /referential/agencies',
  'GET /referential/bareme-versions',
  'GET /referential/calendar',
  'GET /referential/companies',
  'GET /referential/companies/:id',
  'GET /referential/constat-circumstances',
  'GET /referential/convention',
  'GET /referential/experts',
  'GET /referential/irsam-benchmarks',
  'GET /referential/mobile-holiday-kinds',
  'GET /referential/mobile-holidays',
  'GET /referential/motifs',
  'GET /referential/opposition-motifs',
  'GET /referential/vehicle-categories',
  'GET /referential/wilaya-populations',
  'GET /referential/wilayas',
  'GET /settlement/monthly/:period',
  'GET /settlement/monthly/:period/annexe7',
  'GET /settlement/monthly/:period/summary',
  'GET /settlement/quarter/:q',
  'GET /settlement/quarter/:q/matrix',
  'GET /settlement/quarter/:q/pipeline',
  'GET /settlement/quarter/:q/summary',
  'GET /settlement/quarter/closures',
  'GET /stats/monthly',
  'GET /stats/summary',
  'GET /stats/wilayas',
].sort((a, b) => a.localeCompare(b));

describe('SEC-43 — déclarations d’accès de toutes les routes (découverte)', () => {
  let moduleRef: TestingModule;
  let routes: RouteInfo[];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    routes = discoverRoutes(moduleRef);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('découvre les routes de tous les contrôleurs', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.map((r) => r.route)).toEqual(expect.arrayContaining(['GET /me', 'POST /claims/import', 'GET /ledger/verify']));
  });

  it('aucun handler sans déclaration d’accès', () => {
    const undeclared = routes.filter((r) => !r.isPublic && !r.authenticated && r.privileges.length === 0 && r.roles.length === 0).map((r) => r.route);
    expect(undeclared).toEqual([]);
  });

  it('@Public() n’est jamais combiné à une autre déclaration et reste limité aux sondes revues', () => {
    const publicRoutes = routes.filter((r) => r.isPublic);
    expect(publicRoutes.filter((r) => r.authenticated || r.privileges.length > 0 || r.roles.length > 0).map((r) => r.route)).toEqual([]);
    expect(publicRoutes.map((r) => r.route)).toEqual(REVIEWED_PUBLIC_ROUTES);
  });

  it('aucune écriture n’est ouverte par le seul @Authenticated()', () => {
    const openWrites = routes.filter((r) => r.method !== 'GET' && !r.isPublic && r.privileges.length === 0 && r.roles.length === 0).map((r) => r.route);
    expect(openWrites).toEqual([]);
  });

  it('les routes @Authenticated() seules correspondent à la liste revue', () => {
    const authenticatedOnly = routes.filter((r) => !r.isPublic && r.authenticated && r.privileges.length === 0 && r.roles.length === 0).map((r) => r.route);
    expect(authenticatedOnly).toEqual(REVIEWED_AUTHENTICATED_ONLY_ROUTES);
  });
});

describe('SEC-43 — gardes globales (comportement HTTP)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sondes publiques sans authentification', async () => {
    await http().get('/api/v1/health/live').expect(200);
  });

  it('toute autre route exige une authentification (401)', async () => {
    await http().get('/api/v1/stats/summary').expect(401);
    await http().get('/api/v1/referential/wilayas').expect(401);
    await http().get('/api/v1/me').expect(401);
  });

  it('le 403 de privilège ne divulgue pas les privilèges détenus', async () => {
    const res = await http().put('/api/v1/pricing/grid').set({ 'x-dev-user': 'TRESORIER' }).send({}).expect(403);
    expect(res.body.details).toEqual({ required: ['grid'] });
    expect(JSON.stringify(res.body)).not.toContain('held');
  });
});
