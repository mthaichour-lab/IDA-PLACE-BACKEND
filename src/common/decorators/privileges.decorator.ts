import { SetMetadata } from '@nestjs/common';
import { Privilege } from '../rbac/roles-privileges';

export const PRIVILEGES_KEY = 'privileges';

/**
 * Garde déclarative de privilège — B.7 : `@Privileges('matchDecide')`.
 * Combinée à `PrivilegesGuard`, qui vérifie l'identité (token Keycloak ou
 * DevAuthProvider), la matrice rôles × privilèges et les dérogations.
 * Plusieurs privilèges = l'un OU l'autre suffit.
 */
export const Privileges = (...privileges: Privilege[]) => SetMetadata(PRIVILEGES_KEY, privileges);
