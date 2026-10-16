import { Injectable, Logger } from '@nestjs/common';
import { AuthenticatedUser, AuthProvider } from '../../common/interfaces/authenticated-user.interface';

/**
 * TODO(backend-agent) — intégration OIDC Keycloak réelle (B.7, C.3.4).
 *
 * Non implémentée dans cet environnement (pas de serveur Keycloak
 * disponible). À faire pour la mise en production :
 *   1. Vérifier le JWT Bearer (issuer = `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}`,
 *      clients `ida-place-web` public/PKCE côté front, `ida-place-api`
 *      bearer-only côté back) via JWKS (ex: `jwks-rsa` + `jsonwebtoken`, ou
 *      `nest-keycloak-connect`).
 *   2. Extraire le rôle Keycloak (realm role ou groupe) + le `companyId`
 *      (claim custom ou mapping attribut) depuis le token.
 *   3. Charger les dérogations grant/revoke de l'utilisateur (miroir
 *      applicatif `PlaceUser`, voir AdminModule) et calculer les privilèges
 *      effectifs via `RbacService.effectivePrivileges(...)` — même logique
 *      que `DevAuthProvider`, pour que `PrivilegesGuard` reste inchangé.
 *   4. Activer via `AUTH_PROVIDER=keycloak` (voir auth.module.ts) : NE PAS
 *      changer la forme de `AuthenticatedUser` ni celle de `GET /me`.
 *
 * Tant que cette classe n'est pas implémentée, `AUTH_PROVIDER=keycloak`
 * échoue explicitement (pas de "faux admin" de repli — zero-trust).
 */
@Injectable()
export class KeycloakStrategy implements AuthProvider {
  private readonly logger = new Logger('KeycloakStrategy');

  async resolve(): Promise<AuthenticatedUser | null> {
    this.logger.error(
      'KeycloakStrategy non implémenté dans cet environnement. ' +
        'Configurer AUTH_PROVIDER=dev pour le développement local, ' +
        'ou implémenter la vérification OIDC avant de passer en production.',
    );
    throw new Error('KeycloakStrategy: intégration OIDC non implémentée (voir TODO dans le fichier).');
  }
}
