import { CacheService } from './cache.service';

describe('CacheService (REDIS_ENABLED=false — repli no-op)', () => {
  const previous = process.env.REDIS_ENABLED;

  beforeAll(() => {
    process.env.REDIS_ENABLED = 'false';
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.REDIS_ENABLED;
    else process.env.REDIS_ENABLED = previous;
  });

  it('appelle toujours factory() et ne plante jamais sans Redis', async () => {
    const service = new CacheService();
    const factory = jest.fn().mockResolvedValue({ value: 42 });

    const result1 = await service.getOrSet('key', 10, factory);
    const result2 = await service.getOrSet('key', 10, factory);

    expect(result1).toEqual({ value: 42 });
    expect(result2).toEqual({ value: 42 });
    // Pas de cache réel : factory() est rappelée à chaque fois (repli no-op explicite).
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy() ne plante pas sans client Redis', async () => {
    const service = new CacheService();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
