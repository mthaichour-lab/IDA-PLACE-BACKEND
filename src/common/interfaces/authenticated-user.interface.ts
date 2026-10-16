import { Privilege, Role } from '../rbac/roles-privileges';

/**
 * Identité résolue pour la requête courante, quelle que soit la stratégie
 * d'authentification (Keycloak en prod, DevAuthProvider en dev). C'est la
 * forme attachée à `request.user` par `AuthGuard`.
 */
export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Compagnie de rattachement (CORRESPONDANT_IDA / TRESORIER). Absent pour les rôles "place". */
  companyId?: string;
  privileges: Privilege[];
}

/**
 * Contrat que doit respecter tout fournisseur d'authentification
 * (`KeycloakStrategy` en production, `DevAuthProvider` en développement).
 * `resolve` reçoit la requête Express brute et doit renvoyer l'utilisateur
 * authentifié ou `null` si la requête n'est pas authentifiée.
 */
export interface AuthProvider {
  resolve(req: { headers: Record<string, unknown> }): Promise<AuthenticatedUser | null>;
}

export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');
