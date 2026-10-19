import { ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { COMPANY_SCOPED_ROLES } from '../common/rbac/roles-privileges';

/**
 * SEC-25 (plancher de rôles, côté service) : un utilisateur rattaché à une
 * compagnie (rôle de `COMPANY_SCOPED_ROLES`, ou porteur d'un `companyId`)
 * n'est jamais un acteur « place », même s'il détient le privilège requis
 * par une dérogation (`grant`) ou une matrice modifiée. Les actes de la
 * commission, de la clôture et de l'instruction des adhésions sont réservés
 * aux rôles place : une compagnie ne juge pas ses propres dossiers.
 */
export function isPlaceUser(user: AuthenticatedUser): boolean {
  return !COMPANY_SCOPED_ROLES.includes(user.role) && !user.companyId;
}

export function assertPlaceUser(user: AuthenticatedUser): void {
  if (!isPlaceUser(user)) {
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Action réservée aux rôles de la place.' });
  }
}
