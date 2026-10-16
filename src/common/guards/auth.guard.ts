import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AUTH_PROVIDER, AuthProvider } from '../interfaces/authenticated-user.interface';

/**
 * Authentifie la requête via le `AuthProvider` injecté (DevAuthProvider en
 * dev, KeycloakStrategy en prod — voir auth/strategies). Pose `request.user`
 * si résolu, sinon renvoie 401. Doit toujours s'exécuter avant
 * `PrivilegesGuard`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AUTH_PROVIDER) private readonly provider: AuthProvider) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = await this.provider.resolve(req);
    if (!user) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Authentification requise.' });
    }
    req.user = user;
    return true;
  }
}
