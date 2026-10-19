import { SetMetadata } from '@nestjs/common';
import { Role } from '../rbac/roles-privileges';

export const ROLES_KEY = 'roles';

/**
 * Restriction par RÔLE (en plus des privilèges) — vérifiée par
 * `PrivilegesGuard`. Utile quand l'accès dépend du rôle lui-même et non d'un
 * privilège de la matrice : par exemple la lecture du journal scellé, ouverte
 * à `AUDITEUR_CSA` qui ne détient aucun privilège (SEC-16).
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
