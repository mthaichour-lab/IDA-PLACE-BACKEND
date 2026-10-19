import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { MatchQueueQueryDto } from '../matching/dto/matching.dto';
import { MatchQueueItem } from '../matching/entities/match-queue-item.entity';
import { MatchingService } from '../matching/matching.service';
import { AggregateCache } from '../stats/aggregate-cache';
import { ClaimsService } from './claims.service';
import { ListClaimsQueryDto } from './dto/claim.dto';
import { Claim } from './entities/claim.entity';

const caat: AuthenticatedUser = { id: 'c', name: 'Correspondant CAAT', email: 'c@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'CAAT', privileges: [] };

function claimEntity(i: number): Claim {
  return { id: `id-${i}`, company: 'SAA', state: 'A_APPARIER', createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000), raw: {} } as unknown as Claim;
}

describe('SEC-13 — filtre tenant et pagination en base (avant toute limite)', () => {
  it('GET /claims : le filtre compagnie, les filtres et la page sont transmis à la requête', async () => {
    const findAndCount = jest.fn(async () => [[claimEntity(1)], 7001]);
    const service = new ClaimsService({ findAndCount } as never, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never);
    const page = await service.list({ page: 3, pageSize: 20, state: 'A_APPARIER' }, caat);
    expect(findAndCount).toHaveBeenCalledWith(
      { $and: [{ $or: [{ company: 'CAAT' }, { counterpartyCompany: 'CAAT' }] }, { state: 'A_APPARIER' }] },
      { orderBy: { createdAt: 'DESC', id: 'ASC' }, limit: 20, offset: 40 },
    );
    expect(page).toMatchObject({ page: 3, total: 7001 });
  });

  it('GET /matching/queue : filtre tenant et onglet en base, COUNT pour les compteurs, une seule ligne lue pour le détail', async () => {
    const findAndCount = jest.fn(async () => [[], 0]);
    const count = jest.fn(async () => 0);
    const findOne = jest.fn(async () => null);
    const service = new MatchingService({ findAndCount, count, findOne } as never, { get: () => undefined } as never, {} as never, {} as never);
    await service.queue({ filter: 'A_CONFIRMER', page: 2, pageSize: 10 }, caat);
    expect(findAndCount).toHaveBeenCalledWith(
      { $and: [{ $or: [{ companyA: 'CAAT' }, { companyB: 'CAAT' }] }, { status: 'A_CONFIRMER' }] },
      { orderBy: { at: 'DESC', id: 'ASC' }, limit: 10, offset: 10 },
    );
    await service.counters(caat);
    expect(count).toHaveBeenCalledTimes(4);
    await expect(service.getItem('00000000-0000-4000-8000-000000000001', caat)).rejects.toMatchObject({ status: 404 });
    expect(findOne).toHaveBeenCalledWith({ id: '00000000-0000-4000-8000-000000000001' });
    expect(MatchQueueItem).toBeDefined();
  });

  it('?pageSize=100000 est refusé (400) sur /claims et /matching/queue', () => {
    expect(validateSync(plainToInstance(ListClaimsQueryDto, { pageSize: '100000' }))).not.toHaveLength(0);
    expect(validateSync(plainToInstance(MatchQueueQueryDto, { pageSize: '100000' }))).not.toHaveLength(0);
    expect(validateSync(plainToInstance(ListClaimsQueryDto, { pageSize: '100' }))).toHaveLength(0);
  });
});

describe('SEC-36 — lecture de tous les dossiers par lots', () => {
  it('parcourt toute la table par lots de 1 000 (aucune fenêtre de 5 000)', async () => {
    const rows = Array.from({ length: 6500 }, (_, i) => claimEntity(i));
    const find = jest.fn(async (_where: unknown, opts: { limit: number; offset: number }) => rows.slice(opts.offset, opts.offset + opts.limit));
    const service = new ClaimsService({ find, count: jest.fn() } as never, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never);
    const { items, truncated } = await service.listAllForAnalysis();
    expect(items).toHaveLength(6500);
    expect(truncated).toBe(false);
    expect(find).toHaveBeenCalledTimes(7);
  });
});

describe('SEC-13 — agrégats : un seul calcul simultané par clé', () => {
  it('des appels concurrents partagent le même calcul ; un appel ultérieur recalcule (pas de valeur périmée sans Redis)', async () => {
    const cache = new AggregateCache();
    let runs = 0;
    const factory = () => new Promise<number>((resolve) => setTimeout(() => resolve(++runs), 10));
    const results = await Promise.all([cache.get('k', 30, factory), cache.get('k', 30, factory), cache.get('k', 30, factory)]);
    expect(results).toEqual([1, 1, 1]);
    expect(await cache.get('k', 30, factory)).toBe(2);
  });

  it('délègue au cache existant (Redis) quand il est fourni', async () => {
    const getOrSet = jest.fn(async (_k: string, _ttl: number, f: () => Promise<number>) => f());
    await new AggregateCache({ getOrSet } as never).get('stats:summary', 30, async () => 1);
    expect(getOrSet).toHaveBeenCalledWith('stats:summary', 30, expect.any(Function));
  });
});
