import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { cockpitSummaryCacheKey } from './cockpit.module';
import { PlaceOnlyGuard } from './place-only.guard';

const user = (role: AuthenticatedUser['role'], companyId?: string): AuthenticatedUser => ({ id: role, name: role, email: `${role}@test.dz`, role, companyId, privileges: [] });

function ctxFor(u?: AuthenticatedUser): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ user: u }) }) } as unknown as ExecutionContext;
}

describe('SEC-05 — cockpit réservé aux rôles place', () => {
  const guard = new PlaceOnlyGuard();

  it.each(['OPERATEUR_PLACE', 'ADMIN_UAR', 'MEMBRE_COMMISSION', 'AUDITEUR_CSA'] as const)('%s passe la garde', (role) => {
    expect(guard.canActivate(ctxFor(user(role)))).toBe(true);
  });

  it.each(['CORRESPONDANT_IDA', 'TRESORIER'] as const)('%s est refusé (403), même avec tous les privilèges', (role) => {
    const u = { ...user(role, 'CAAT'), privileges: ['admin', 'bill', 'closeQuarter'] as AuthenticatedUser['privileges'] };
    expect(() => guard.canActivate(ctxFor(u))).toThrow(ForbiddenException);
  });

  it('utilisateur non résolu : refusé', () => {
    expect(() => guard.canActivate(ctxFor(undefined))).toThrow(ForbiddenException);
  });

  it('deux tenants n’obtiennent jamais la même entrée de cache', () => {
    const keys = new Set([cockpitSummaryCacheKey(user('OPERATEUR_PLACE')), cockpitSummaryCacheKey(user('TRESORIER', 'CAAT')), cockpitSummaryCacheKey(user('TRESORIER', 'SAA'))]);
    expect(keys.size).toBe(3);
    expect(cockpitSummaryCacheKey(user('AUDITEUR_CSA'))).toBe(cockpitSummaryCacheKey(user('OPERATEUR_PLACE')));
  });
});
