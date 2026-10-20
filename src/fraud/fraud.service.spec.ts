import { ConfigService } from '@nestjs/config';
import { ClaimViewDto } from '../claims/dto/claim.dto';
import { ClaimsService } from '../claims/claims.service';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { MatchingService } from '../matching/matching.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import { FraudService } from './fraud.service';

/** Base injoignable : erreur de connexion (repli mémoire). */
function connectionError(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
}

function unreachableRepo() {
  const fail = () =>
    jest.fn(async () => {
      throw connectionError();
    });
  return {
    create: jest.fn((d: unknown) => d),
    find: fail(),
    findOne: fail(),
    findAll: fail(),
    findAndCount: fail(),
    count: fail(),
    getEntityManager: jest.fn(() => {
      // RequestContext.create (SEC-13, voir fraud.service.ts) appelle
      // em.fork() : une valeur minimale suffit, cette spec ne teste pas le
      // comportement contextuel de MikroORM lui-même.
      const em: Record<string, unknown> = { persist: jest.fn(), flush: fail(), persistAndFlush: fail() };
      em.fork = jest.fn(() => em);
      return em;
    }),
  };
}

function claim(i: number, overrides: Partial<ClaimViewDto> = {}): ClaimViewDto {
  return {
    id: `c-${i}`,
    numEconstat: `EC-${i}`,
    company: 'CAAT',
    counterpartyCompany: 'SAA',
    accidentDate: '2026-01-10',
    wilaya: '16',
    estimatedAmount: 1000,
    state: 'A_APPARIER',
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    plateA: `P-${i}`,
    ...overrides,
  };
}

describe('FraudService — SEC-13 (aucun GET n’écrit) et SEC-36 (pas de fenêtre de 5 000 dossiers)', () => {
  let claims: ClaimViewDto[];
  let truncated: boolean;
  let listAllForAnalysis: jest.Mock;
  let gateway: RealtimeGateway;
  let service: FraudService;
  let caseRepo: ReturnType<typeof unreachableRepo>;

  const operateur: AuthenticatedUser = { id: 'op', name: 'Opérateur', email: 'op@test.dz', role: 'OPERATEUR_PLACE', privileges: [] };

  beforeEach(() => {
    claims = [];
    truncated = false;
    listAllForAnalysis = jest.fn(async () => ({ items: claims, truncated }));
    const claimsService = {
      listAllForAnalysis,
      summariesFor: jest.fn(async (ids: string[]) => claims.filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id, company: c.company, plateA: c.plateA }))),
    } as unknown as ClaimsService;
    const matching = { listInternalPairs: jest.fn(async () => []) } as unknown as MatchingService;
    gateway = new RealtimeGateway({ resolve: async () => null });
    caseRepo = unreachableRepo();
    service = new FraudService(caseRepo as never, unreachableRepo() as never, claimsService, matching, gateway, { get: () => undefined } as unknown as ConfigService);
  });

  it('GET /fraud/cases ne déclenche aucun recalcul ni aucune écriture', async () => {
    claims = [claim(1), claim(2, { plateA: 'P-1' })];
    await service.cases(1, 6, operateur);
    await service.cases(1, 6, operateur);
    expect(listAllForAnalysis).not.toHaveBeenCalled();
    expect(caseRepo.findOne).not.toHaveBeenCalled(); // upsert des cas = écriture
  });

  it('le recalcul est déclenché par l’ingestion (claim.ingested) ; les appels simultanés sont regroupés sous verrou', async () => {
    claims = [claim(1), claim(2, { plateA: 'P-1' })];
    gateway.emitEvent('claim.ingested', { company: 'CAAT' });
    gateway.emitEvent('claim.ingested', { company: 'CAAT' });
    gateway.emitEvent('claim.ingested', { company: 'CAAT' });
    await service.scheduleRecompute('test');
    // 1 calcul + 1 rejeu (déclenchements arrivés pendant le calcul), jamais 3 en parallèle.
    expect(listAllForAnalysis).toHaveBeenCalledTimes(2);
    const page = await service.cases(1, 6, operateur);
    expect(page.items.some((c) => c.type === 'DOUBLON' && c.claimIds.includes('c-1') && c.claimIds.includes('c-2'))).toBe(true);
  });

  it('un doublon parmi les dossiers les PLUS ANCIENS est détecté au-delà de 5 000 dossiers', async () => {
    claims = Array.from({ length: 6000 }, (_, i) => claim(i + 10, { plateA: `UNIQUE-${i}`, accidentDate: `2026-0${(i % 9) + 1}-1${i % 10}`, createdAt: new Date(Date.UTC(2026, 5, 1) + i * 60_000).toISOString() }));
    // Les deux plus anciens : même plaque, même jour (doublon).
    claims.push(claim(1, { plateA: 'DOUBLE', accidentDate: '2025-01-05', createdAt: '2025-01-05T08:00:00.000Z' }));
    claims.push(claim(2, { plateA: 'DOUBLE', accidentDate: '2025-01-05', createdAt: '2025-01-05T09:00:00.000Z' }));
    await service.scheduleRecompute('test');
    const page = await service.cases(1, 100, operateur);
    expect(page.items.some((c) => c.type === 'DOUBLON' && c.claimIds.includes('c-1') && c.claimIds.includes('c-2'))).toBe(true);
    expect(page.analysis).toMatchObject({ claimsAnalyzed: 6002, truncated: false });
  });

  it('une troncature (plafond ANALYSIS_MAX_CLAIMS atteint) est signalée dans la réponse, jamais masquée', async () => {
    claims = [claim(1)];
    truncated = true;
    await service.scheduleRecompute('test');
    expect((await service.cases(1, 6, operateur)).analysis.truncated).toBe(true);
  });
});
