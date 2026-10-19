import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { resolveTenantFilter } from '../common/rbac/tenant-scope';

/**
 * Garde « rôles de place uniquement » (SEC-05, SEC-21, SEC-26) : refuse
 * (403) tout utilisateur rattaché à une compagnie (CORRESPONDANT_IDA,
 * TRESORIER), quels que soient ses privilèges ou dérogations — les vues
 * agrégées place-entière (positions de toutes les compagnies, journal de
 * place, chiffre d'affaires de l'opérateur) n'ont pas de variante filtrée.
 *
 * Contrôle par RÔLE plutôt que par `@Privileges` : aucun privilège existant
 * ne couvre exactement les rôles place (AUDITEUR_CSA, lecture complète par
 * définition, n'en détient aucun ; `bill` est aussi détenu par TRESORIER).
 * À déplacer dans `src/common/guards` (hors du périmètre de ce correctif).
 * S'applique APRÈS `AuthGuard` (`request.user` résolu).
 */
@Injectable()
export class PlaceOnlyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const user: AuthenticatedUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user || resolveTenantFilter(user) !== undefined) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès réservé aux rôles de place.' });
    }
    return true;
  }
}
