import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { CockpitController, cockpitSummaryCacheKey } from './cockpit.module';

const user = (role: AuthenticatedUser['role'], companyId?: string): AuthenticatedUser => ({ id: role, name: role, email: `${role}@test.dz`, role, companyId, privileges: [] });

/** Contexte HTTP `GET /cockpit/summary` pour la garde réelle (métadonnées `@Roles` du handler). */
function summaryContext(u?: AuthenticatedUser): ExecutionContext {
  return {
    getHandler: () => CockpitController.prototype.summary,
    getClass: () => CockpitController,
    switchToHttp: () => ({ getRequest: () => ({ user: u, method: 'GET' }) }),
  } as unknown as ExecutionContext;
}

describe('SEC-05 — cockpit réservé aux rôles place', () => {
  const guard = new PrivilegesGuard(new Reflector());

  it.each(['OPERATEUR_PLACE', 'ADMIN_UAR', 'MEMBRE_COMMISSION', 'AUDITEUR_CSA'] as const)('%s passe la garde', (role) => {
    expect(guard.canActivate(summaryContext(user(role)))).toBe(true);
  });

  it.each(['CORRESPONDANT_IDA', 'TRESORIER'] as const)('%s est refusé (403), même avec des privilèges dérogatoires', (role) => {
    const u = { ...user(role, 'CAAT'), privileges: ['bill', 'synth'] as AuthenticatedUser['privileges'] };
    expect(() => guard.canActivate(summaryContext(u))).toThrow(ForbiddenException);
  });

  it('deux tenants n’obtiennent jamais la même entrée de cache', () => {
    const keys = new Set([cockpitSummaryCacheKey(user('OPERATEUR_PLACE')), cockpitSummaryCacheKey(user('TRESORIER', 'CAAT')), cockpitSummaryCacheKey(user('TRESORIER', 'SAA'))]);
    expect(keys.size).toBe(3);
    expect(cockpitSummaryCacheKey(user('AUDITEUR_CSA'))).toBe(cockpitSummaryCacheKey(user('OPERATEUR_PLACE')));
  });
});
