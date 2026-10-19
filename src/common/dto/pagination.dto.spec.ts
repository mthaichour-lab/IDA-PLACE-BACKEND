import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MAX_PAGE_SIZE, PaginationQueryDto } from './pagination.dto';

/** SEC-13 — `pageSize` borné à 100. */
describe('PaginationQueryDto (SEC-13)', () => {
  const errorsFor = (query: Record<string, unknown>) => validateSync(plainToInstance(PaginationQueryDto, query));

  it('refuse pageSize=100000', () => {
    expect(errorsFor({ pageSize: '100000' }).map((e) => e.property)).toContain('pageSize');
  });

  it('accepte pageSize=100 (maximum) et la valeur par défaut', () => {
    expect(MAX_PAGE_SIZE).toBe(100);
    expect(errorsFor({ pageSize: '100' })).toEqual([]);
    expect(errorsFor({})).toEqual([]);
  });

  it('refuse pageSize=0 et une valeur non entière', () => {
    expect(errorsFor({ pageSize: '0' })).toHaveLength(1);
    expect(errorsFor({ pageSize: 'abc' })).toHaveLength(1);
  });
});
