import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PRIVILEGES_KEY } from '../decorators/privileges.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { Privilege, Role } from '../rbac/roles-privileges';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Garde de privilège — B.7. S'appuie sur `request.user.privileges`
 * (calculés par `RbacService` à partir du rôle + dérogations grant/revoke,
 * voir `auth.service.ts`). Règle absolue : `AUDITEUR_CSA` ne peut jamais
 * effectuer d'action d'écriture, quelles que soient les cases de la
 * matrice ou les dérogations — vérifié ici indépendamment du reste.
 */
@Injectable()
export class PrivilegesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Privilege[]>(PRIVILEGES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    const req = ctx.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = req.user;
    if (!user) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Utilisateur non résolu.' });
    }

    if (user.role === 'AUDITEUR_CSA' && MUTATING_METHODS.has(req.method)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'AUDITEUR_CSA est en lecture seule.',
      });
    }

    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles && roles.length > 0 && !roles.includes(user.role)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Rôle non autorisé pour cette ressource.' });
    }

    if (!required || required.length === 0) return true;

    const ok = required.some((p) => user.privileges.includes(p));
    if (!ok) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: `Privilège requis manquant (${required.join(' ou ')}).`,
        details: { required, held: user.privileges },
      });
    }
    return true;
  }
}
