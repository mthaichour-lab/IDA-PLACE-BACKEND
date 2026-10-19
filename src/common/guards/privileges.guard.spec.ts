import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Authenticated, Public } from '../decorators/access.decorator';
import { Privileges } from '../decorators/privileges.decorator';
import { Roles } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { PrivilegesGuard } from './privileges.guard';

/** SEC-43 — garde fermée par défaut, refus non bavard. */
class FakeController {
  undeclared() {}
  @Authenticated()
  open() {}
  @Privileges('grid')
  grid() {}
  @Roles('ADMIN_UAR')
  uarOnly() {}
  @Public()
  probe() {}
}

const user = (role: string, privileges: string[] = []): AuthenticatedUser =>
  ({ id: 'u1', name: 'U', email: 'u@x', role, privileges }) as unknown as AuthenticatedUser;

function ctx(handler: keyof FakeController, u: AuthenticatedUser | undefined, method = 'GET'): ExecutionContext {
  return {
    getHandler: () => FakeController.prototype[handler],
    getClass: () => FakeController,
    switchToHttp: () => ({ getRequest: () => ({ user: u, method }) }),
  } as unknown as ExecutionContext;
}

function forbiddenBody(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ForbiddenException);
    return (e as ForbiddenException).getResponse() as Record<string, unknown>;
  }
  throw new Error('403 attendu');
}

describe('PrivilegesGuard — SEC-43', () => {
  const guard = new PrivilegesGuard(new Reflector());
  const admin = user('ADMIN_UAR', ['grid', 'admin']);

  it('refuse un handler sans aucune déclaration, même pour un administrateur', () => {
    const body = forbiddenBody(() => guard.canActivate(ctx('undeclared', admin)));
    expect(body).toEqual({ code: 'FORBIDDEN', message: 'Accès refusé.' });
  });

  it('@Authenticated() : ouvert à tout utilisateur authentifié', () => {
    expect(guard.canActivate(ctx('open', user('TRESORIER')))).toBe(true);
  });

  it('@Public() : passe sans utilisateur', () => {
    expect(guard.canActivate(ctx('probe', undefined))).toBe(true);
  });

  it('@Roles() : rôle vérifié', () => {
    expect(guard.canActivate(ctx('uarOnly', admin))).toBe(true);
    forbiddenBody(() => guard.canActivate(ctx('uarOnly', user('OPERATEUR_PLACE'))));
  });

  it('privilège manquant : 403 sans les privilèges détenus (`held`)', () => {
    const body = forbiddenBody(() => guard.canActivate(ctx('grid', user('CORRESPONDANT_IDA', ['insert', 'import']))));
    expect(body.details).toEqual({ required: ['grid'] });
    expect(JSON.stringify(body)).not.toContain('insert');
  });

  it('AUDITEUR_CSA reste en lecture seule même sur une route @Authenticated()', () => {
    forbiddenBody(() => guard.canActivate(ctx('open', user('AUDITEUR_CSA'), 'POST')));
  });
});
