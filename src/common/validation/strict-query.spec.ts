import { CallHandler, Controller, ExecutionContext, Get, Query } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { IsOptional, IsString, validateSync } from 'class-validator';
import { lastValueFrom, of } from 'rxjs';
import { ListClaimsQueryDto } from '../../claims/dto/claim.dto';
import { MatchDecisionDto } from '../../matching/dto/matching.dto';
import { StatsWilayasQueryDto } from '../../stats/dto/stats-query.dto';
import { PaginationQueryDto } from '../dto/pagination.dto';
import { allowedQueryKeys, describeQueryDeclaration, StrictQuery, StrictQueryInterceptor } from './strict-query';

class FilteredPageDto extends PaginationQueryDto {
  @IsOptional() @IsString() status?: string;
}

class ExplicitDto {
  @IsOptional() @IsString() token?: string;
}

@Controller('probe')
class ProbeController {
  @Get('dto')
  withDto(@Query() _q: FilteredPageDto) {}

  @Get('named')
  named(@Query('year') _year: string) {}

  @Get('none')
  none() {}

  @Get('untyped')
  untyped(@Query() _q: Record<string, string>) {}

  @Get('explicit')
  @StrictQuery(ExplicitDto)
  explicit() {}
}

const interceptor = new StrictQueryInterceptor(new Reflector());
const next: CallHandler = { handle: () => of('ok') };

function call(handler: keyof ProbeController, query: Record<string, unknown>) {
  const ctx = {
    getType: () => 'http',
    getClass: () => ProbeController,
    getHandler: () => ProbeController.prototype[handler],
    switchToHttp: () => ({ getRequest: () => ({ query }) }),
  } as unknown as ExecutionContext;
  return () => interceptor.intercept(ctx, next);
}

describe('SEC-44 — paramètres de requête stricts (intercepteur global)', () => {
  it('clés autorisées déduites du DTO de @Query(), héritage compris', () => {
    expect(allowedQueryKeys(FilteredPageDto).sort()).toEqual(['page', 'pageSize', 'status']);
    expect(describeQueryDeclaration(ProbeController, ProbeController.prototype.withDto)).toEqual({ keys: expect.arrayContaining(['page', 'pageSize', 'status']), untypedWholeQuery: false });
  });

  it('?company[$ne]=X et toute clé hors DTO : 400 PARAMETRE_INCONNU, sans écho illimité', async () => {
    expect(call('withDto', { 'companyId[$ne]': 'CAAT' })).toThrow(expect.objectContaining({ status: 400 }));
    try {
      call('withDto', Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`${'x'.repeat(100)}${i}`, '1'])))();
      throw new Error('400 attendu');
    } catch (e) {
      const body = (e as { getResponse: () => { code: string; details: { parametres: string[] } } }).getResponse();
      expect(body.code).toBe('PARAMETRE_INCONNU');
      expect(body.details.parametres).toHaveLength(5);
      expect(body.details.parametres.every((k) => k.length <= 64)).toBe(true);
    }
    await expect(lastValueFrom(call('withDto', { page: '1', pageSize: '6', status: 'X' })() as never)).resolves.toBe('ok');
  });

  it('@Query(\'cle\') nommé : seule cette clé', () => {
    expect(call('named', { year: '2026' })).not.toThrow();
    expect(call('named', { year: '2026', other: '1' })).toThrow();
  });

  it('route sans @Query : toute query string est refusée', () => {
    expect(call('none', {})).not.toThrow();
    expect(call('none', { page: '1' })).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('@Query() non typé : fermé (aucune clé) et signalé', () => {
    expect(describeQueryDeclaration(ProbeController, ProbeController.prototype.untyped).untypedWholeQuery).toBe(true);
    expect(call('untyped', { a: '1' })).toThrow();
  });

  it('@StrictQuery(Dto) explicite remplace la déduction', () => {
    expect(call('explicit', { token: 'x' })).not.toThrow();
    expect(call('explicit', { page: '1' })).toThrow();
  });

  it('DTO : code compagnie, année et identifiants bornés', () => {
    expect(validateSync(plainToInstance(ListClaimsQueryDto, { company: 'CAAT' }))).toHaveLength(0);
    expect(validateSync(plainToInstance(ListClaimsQueryDto, { company: "x' or 1=1" }))).not.toHaveLength(0);
    expect(validateSync(plainToInstance(StatsWilayasQueryDto, { year: '99999' }))).not.toHaveLength(0);
    expect(validateSync(plainToInstance(MatchDecisionDto, { action: 'link', linkDeclId: 'pas-un-uuid' }))).not.toHaveLength(0);
    expect(validateSync(plainToInstance(MatchDecisionDto, { action: 'reject', reason: 'x'.repeat(501) }))).not.toHaveLength(0);
  });
});
