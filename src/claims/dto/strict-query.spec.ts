import { ExecutionContext } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { of } from 'rxjs';
import { MatchDecisionDto } from '../../matching/dto/matching.dto';
import { ListClaimsQueryDto } from './claim.dto';
import { StatsWilayasQueryDto } from './strict-query.pipe';
import { StrictQuery } from './strict-query.pipe';

/** Récupère l'intercepteur posé par `@StrictQuery(Dto)` sur une méthode factice. */
function interceptorFor(dto: new () => unknown) {
  class Probe {
    @StrictQuery(dto)
    route() {}
  }
  const [interceptor] = Reflect.getMetadata('__interceptors__', Probe.prototype.route) as Array<{ intercept: (c: ExecutionContext, n: { handle: () => unknown }) => unknown }>;
  return (query: Record<string, unknown>) => interceptor.intercept({ switchToHttp: () => ({ getRequest: () => ({ query }) }) } as unknown as ExecutionContext, { handle: () => of(null) });
}

describe('SEC-44 — DTO de requête et paramètres typés', () => {
  it('?company[$ne]=X et toute clé hors DTO : refusées (400 PARAMETRE_INCONNU)', () => {
    const check = interceptorFor(ListClaimsQueryDto);
    expect(() => check({ 'company[$ne]': 'CAAT' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => check({ 'companyId[$ne]': 'CAAT' })).toThrow();
    expect(() => check({ page: '1', pageSize: '6', company: 'CAAT', state: 'A_APPARIER' })).not.toThrow();
  });

  it('code compagnie, année et identifiants bornés', () => {
    expect(validateSync(plainToInstance(ListClaimsQueryDto, { company: 'CAAT' }))).toHaveLength(0);
    expect(validateSync(plainToInstance(ListClaimsQueryDto, { company: "x' or 1=1" }))).not.toHaveLength(0);
    expect(validateSync(plainToInstance(StatsWilayasQueryDto, { year: '99999' }))).not.toHaveLength(0);
    expect(validateSync(plainToInstance(MatchDecisionDto, { action: 'link', linkDeclId: 'pas-un-uuid' }))).not.toHaveLength(0);
    expect(validateSync(plainToInstance(MatchDecisionDto, { action: 'reject', reason: 'x'.repeat(501) }))).not.toHaveLength(0);
  });
});
