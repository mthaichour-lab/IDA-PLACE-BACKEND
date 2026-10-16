import { ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { COMPANY_SCOPED_ROLES } from './roles-privileges';

/**
 * Scoping tenant — B.7 : un CORRESPONDANT_IDA ou TRESORIER ne voit que les
 * données de sa compagnie (minimisation, loi 18-07). Les rôles "place"
 * (OPERATEUR_PLACE, ADMIN_UAR, MEMBRE_COMMISSION, AUDITEUR_CSA) voient tout.
 *
 * Renvoie l'id de compagnie à appliquer en filtre, ou `undefined` si
 * l'utilisateur a une visibilité "place" (aucun filtre).
 */
export function resolveTenantFilter(user: AuthenticatedUser): string | undefined {
  if (COMPANY_SCOPED_ROLES.includes(user.role)) {
    if (!user.companyId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Utilisateur rattaché à une compagnie mais sans companyId.',
      });
    }
    return user.companyId;
  }
  return undefined;
}

/** Vérifie qu'un utilisateur scopé compagnie n'accède qu'à SA compagnie. */
export function assertCompanyAccess(user: AuthenticatedUser, companyId: string): void {
  const tenant = resolveTenantFilter(user);
  if (tenant && tenant !== companyId) {
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
  }
}
