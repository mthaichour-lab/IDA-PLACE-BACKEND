import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/access.decorator';
import { AUTH_PROVIDER, AuthProvider } from '../interfaces/authenticated-user.interface';

/** Marque posée sur la requête une fois l'authentification faite (clé non sérialisable, inaccessible au client). */
const AUTHENTICATED_REQUEST = Symbol('ida.authenticated');

/**
 * Authentifie la requête via le `AuthProvider` injecté (DevAuthProvider en
 * dev, KeycloakStrategy en prod — voir auth/strategies). Pose `request.user`
 * si résolu, sinon renvoie 401. Doit toujours s'exécuter avant
 * `PrivilegesGuard`.
 *
 * SEC-43 : enregistrée en garde GLOBALE (`APP_GUARD`, voir `app.module.ts`) —
 * un contrôleur qui oublierait `@UseGuards` reste authentifié. Seules les
 * routes `@Public()` (sondes d'exploitation) en sont exemptées.
 * Idempotente : si la requête a déjà été authentifiée par cette garde (garde
 * répétée au niveau d'un contrôleur), le fournisseur n'est pas rappelé.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    if (req[AUTHENTICATED_REQUEST] === true && req.user) return true;

    const user = await this.provider.resolve(req);
    if (!user) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Authentification requise.' });
    }
    req.user = user;
    req[AUTHENTICATED_REQUEST] = true;
    return true;
  }
}
