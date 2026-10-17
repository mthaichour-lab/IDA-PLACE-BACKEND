import { createPublicKey, JsonWebKey } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { AuthenticatedUser, AuthProvider } from '../../common/interfaces/authenticated-user.interface';
import { RbacService } from '../../common/rbac/rbac.service';
import { ROLES, Role } from '../../common/rbac/roles-privileges';

interface Jwk extends JsonWebKey {
  kid: string;
}

interface Jwks {
  keys: Jwk[];
}

interface KeycloakTokenPayload {
  sub: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  azp?: string;
  aud?: string | string[];
  iss?: string;
  realm_access?: { roles: string[] };
  /** Claim custom explicite (mapper Keycloak) — priorité sur `realm_access.roles` si présente. */
  ida_place_role?: string;
  /** Claim custom (mapper Keycloak, attribut utilisateur) — B.7, rôles CORRESPONDANT_IDA/TRESORIER. */
  company_id?: string;
}

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * KeycloakStrategy — intégration OIDC Keycloak réelle (B.7, C.3.4).
 *
 * Vérifie le JWT Bearer via JWKS (realm Keycloak), mappe le rôle Keycloak
 * vers l'un des 6 rôles RBAC internes et calcule les privilèges effectifs
 * via `RbacService` — EXACTEMENT comme `DevAuthProvider`, pour que
 * `AuthGuard`/`PrivilegesGuard` et la forme de `AuthenticatedUser`/`GET /me`
 * restent inchangés (contrat stable, voir HANDOFF.md).
 *
 * Hypothèses de mapping documentées (le dossier technique ne fixe pas le
 * détail des claims Keycloak — à valider avec la configuration réelle du
 * realm "ida-place") :
 *  - rôle applicatif : claim custom `ida_place_role` si présente (mapper
 *    Keycloak dédié), sinon la première correspondance trouvée dans
 *    `realm_access.roles` parmi les 6 rôles internes (`ROLES`) — suppose
 *    donc que les rôles de realm Keycloak portent EXACTEMENT les mêmes noms
 *    (`OPERATEUR_PLACE`, `ADMIN_UAR`, ...).
 *  - `companyId` (CORRESPONDANT_IDA/TRESORIER) : claim custom
 *    `company_id` (attribut utilisateur mappé en claim côté Keycloak).
 *  - client autorisé : le jeton doit avoir été émis pour `ida-place-web`
 *    ou `ida-place-api` (`azp`, sinon premier élément de `aud`) — rejeté
 *    sinon.
 *
 * Testable SANS serveur Keycloak réel : `getJwks()` appelle `fetch` (Node
 * ≥18, déjà la version minimale du projet — voir package.json "engines"),
 * mockable dans les tests (voir `keycloak.strategy.spec.ts`, qui construit
 * un vrai jeu de clés RSA et un JWT signé localement).
 *
 * Zero-trust (voir README "Mode dégradé") : si `AUTH_PROVIDER=keycloak` est
 * sélectionné sans configuration minimale valide, `assertConfigured()` (
 * appelée par `auth.module.ts` AU DÉMARRAGE, uniquement quand ce provider
 * est effectivement choisi) lève une erreur explicite — JAMAIS de repli
 * "admin" silencieux.
 */
@Injectable()
export class KeycloakStrategy implements AuthProvider {
  private readonly logger = new Logger('KeycloakStrategy');
  private jwksCache?: { fetchedAt: number; keys: Jwk[] };

  constructor(private readonly rbac: RbacService) {}

  private get baseUrl(): string | undefined {
    return process.env.KEYCLOAK_BASE_URL;
  }

  private get realm(): string | undefined {
    return process.env.KEYCLOAK_REALM;
  }

  private get clientId(): string | undefined {
    return process.env.KEYCLOAK_CLIENT_ID;
  }

  private get issuer(): string | undefined {
    return this.baseUrl && this.realm ? `${this.baseUrl.replace(/\/$/, '')}/realms/${this.realm}` : undefined;
  }

  private get jwksUrl(): string | undefined {
    return this.issuer ? `${this.issuer}/protocol/openid-connect/certs` : undefined;
  }

  /**
   * Configuration minimale requise pour vérifier un JWT Keycloak. Appelée
   * par `auth.module.ts` UNIQUEMENT quand `AUTH_PROVIDER=keycloak` est
   * effectivement sélectionné (jamais au simple chargement de la classe,
   * qui reste toujours instanciée par le conteneur Nest aux côtés de
   * `DevAuthProvider` — même principe que `S3StorageProvider`, voir
   * documents/providers/s3.provider.ts) : ne doit jamais casser le mode dev
   * (`AUTH_PROVIDER=dev`) par un throw de constructeur.
   */
  assertConfigured(): void {
    const missing = ['KEYCLOAK_BASE_URL', 'KEYCLOAK_REALM', 'KEYCLOAK_CLIENT_ID'].filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(
        `KeycloakStrategy: AUTH_PROVIDER=keycloak activé mais configuration manquante (${missing.join(', ')}). ` +
          'Jamais de repli admin silencieux (zero-trust) — corriger la configuration ou repasser en AUTH_PROVIDER=dev en développement.',
      );
    }
  }

  private async getJwks(forceRefresh = false): Promise<Jwk[]> {
    if (!forceRefresh && this.jwksCache && Date.now() - this.jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
      return this.jwksCache.keys;
    }
    const url = this.jwksUrl;
    if (!url) throw new Error('KeycloakStrategy: KEYCLOAK_BASE_URL/KEYCLOAK_REALM manquants.');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`KeycloakStrategy: échec de récupération du JWKS (${res.status} ${res.statusText}).`);
    const body = (await res.json()) as Jwks;
    this.jwksCache = { fetchedAt: Date.now(), keys: body.keys ?? [] };
    return this.jwksCache.keys;
  }

  private async resolvePublicKeyPem(kid: string): Promise<string> {
    let keys = await this.getJwks();
    let jwk = keys.find((k) => k.kid === kid);
    if (!jwk) {
      // kid inconnu du cache : rotation de clé récente côté Keycloak possible — un seul refresh forcé.
      keys = await this.getJwks(true);
      jwk = keys.find((k) => k.kid === kid);
    }
    if (!jwk) throw new Error(`KeycloakStrategy: aucune clé JWKS ne correspond au "kid" du jeton ("${kid}").`);
    const keyObject = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
    return keyObject.export({ type: 'spki', format: 'pem' }) as string;
  }

  /** Mapping rôle Keycloak → rôle RBAC interne — B.7 (voir hypothèses dans la doc de classe). */
  private extractRole(payload: KeycloakTokenPayload): Role | undefined {
    if (payload.ida_place_role && (ROLES as readonly string[]).includes(payload.ida_place_role)) {
      return payload.ida_place_role as Role;
    }
    const realmRoles = payload.realm_access?.roles ?? [];
    return ROLES.find((r) => realmRoles.includes(r));
  }

  async resolve(req: { headers: Record<string, unknown> }): Promise<AuthenticatedUser | null> {
    this.assertConfigured();

    const authz = req.headers['authorization'] as string | undefined;
    if (!authz?.startsWith('Bearer ')) return null;
    const token = authz.slice(7);

    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded && typeof decoded === 'object' ? (decoded.header as { kid?: string }).kid : undefined;
    if (!kid) {
      this.logger.warn('JWT Keycloak sans "kid" dans son en-tête — rejeté.');
      return null;
    }

    let publicKeyPem: string;
    try {
      publicKeyPem = await this.resolvePublicKeyPem(kid);
    } catch (err) {
      this.logger.error(`KeycloakStrategy: ${(err as Error).message}`);
      return null;
    }

    let payload: KeycloakTokenPayload;
    try {
      payload = jwt.verify(token, publicKeyPem, { algorithms: ['RS256'], issuer: this.issuer }) as KeycloakTokenPayload;
    } catch (err) {
      this.logger.warn(`JWT Keycloak invalide (${(err as Error).message}).`);
      return null;
    }

    // Clients attendus — ida-place-web (public/PKCE, front) ou ida-place-api
    // (bearer-only, back) — voir doc de classe.
    const expectedClients = [this.clientId, 'ida-place-web', 'ida-place-api'].filter((v): v is string => !!v);
    const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    const tokenClient = payload.azp ?? aud[0];
    if (tokenClient && !expectedClients.includes(tokenClient)) {
      this.logger.warn(`JWT Keycloak émis pour un client inattendu ("${tokenClient}") — rejeté.`);
      return null;
    }

    const role = this.extractRole(payload);
    if (!role) {
      this.logger.warn('JWT Keycloak sans rôle applicatif reconnu (realm_access.roles / ida_place_role) — rejeté.');
      return null;
    }

    // Dérogations grant/revoke par utilisateur (miroir applicatif PlaceUser,
    // AdminModule) : pas encore synchronisées depuis ce provider — éviterait
    // une dépendance inverse AuthModule → AdminModule (ARCHITECTURE.md).
    // TODO sprint suivant.
    const privileges = this.rbac.effectivePrivileges(role, [], []);

    return {
      id: payload.sub,
      name: payload.name ?? payload.preferred_username ?? payload.sub,
      email: payload.email ?? payload.preferred_username ?? '',
      role,
      companyId: payload.company_id,
      privileges,
    };
  }
}
