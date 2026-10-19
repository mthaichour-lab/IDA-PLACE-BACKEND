import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTHENTICATED_KEY, IS_PUBLIC_KEY } from '../decorators/access.decorator';
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
 *
 * SEC-43 (revue sécurité 2026-10-19) — FERMÉE PAR DÉFAUT : un handler qui ne
 * déclare ni `@Privileges(...)`, ni `@Roles(...)`, ni `@Authenticated()`
 * (ni `@Public()`) est refusé, au lieu d'être ouvert à tout utilisateur
 * authentifié. Le 403 ne divulgue plus les privilèges détenus (`held`).
 * Enregistrée en garde globale (`APP_GUARD`, voir `app.module.ts`).
 */
@Injectable()
export class PrivilegesGuard implements CanActivate {
  private readonly logger = new Logger('PrivilegesGuard');

  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

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

    const required = this.reflector.getAllAndOverride<Privilege[]>(PRIVILEGES_KEY, targets);
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    const anyAuthenticated = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, targets) === true;

    const hasPrivileges = !!required && required.length > 0;
    const hasRoles = !!roles && roles.length > 0;
    if (!hasPrivileges && !hasRoles && !anyAuthenticated) {
      // Oubli de déclaration : refus (et trace serveur pour le développeur), jamais d'ouverture implicite.
      this.logger.error(`Route sans déclaration d'accès refusée : ${ctx.getClass().name}.${ctx.getHandler().name}`);
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès refusé.' });
    }

    if (hasRoles && !roles.includes(user.role)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Rôle non autorisé pour cette ressource.' });
    }

    if (!hasPrivileges) return true;

    const ok = required.some((p) => user.privileges.includes(p));
    if (!ok) {
      // SEC-43 : on indique le privilège attendu (utile au frontend), jamais ceux que l'appelant détient.
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: `Privilège requis manquant (${required.join(' ou ')}).`,
        details: { required },
      });
    }
    return true;
  }
}
