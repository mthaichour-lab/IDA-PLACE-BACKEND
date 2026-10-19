import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';
import { PlaceUserDirectory } from '../../common/directory/place-user-directory.service';
import { AuthenticatedUser, AuthProvider } from '../../common/interfaces/authenticated-user.interface';
import { sanitizeForLog } from '../../common/logging/sanitize-log';
import { RbacService } from '../../common/rbac/rbac.service';
import { ROLES, Role } from '../../common/rbac/roles-privileges';

interface KeycloakTokenPayload {
  sub: string;
  typ?: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  name?: string;
  azp?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  realm_access?: { roles: string[] };
  /** Claim custom explicite (mapper Keycloak) — règle explicite si présente. */
  ida_place_role?: string;
  /** Claim custom (mapper Keycloak, attribut utilisateur) — B.7, rôles CORRESPONDANT_IDA/TRESORIER. */
  company_id?: string;
}

/** Cache des clés publiques (par `kid`). */
export const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
/** Nombre maximal d'appels au JWKS par minute (protège Keycloak d'un flot de `kid` inconnus — SEC-24). */
export const JWKS_REQUESTS_PER_MINUTE = 10;
/** Délai d'attente d'un appel JWKS. */
export const JWKS_TIMEOUT_MS = 5000;
/** Forme acceptée d'un `kid` avant tout appel réseau (les `kid` Keycloak sont courts, alphanumériques). */
const KID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * KeycloakStrategy — intégration OIDC Keycloak réelle (B.7, C.3.4).
 *
 * Vérifie le JWT Bearer via JWKS (realm Keycloak), mappe le rôle Keycloak
 * vers l'un des 6 rôles RBAC internes et calcule les privilèges effectifs
 * via `RbacService` — EXACTEMENT comme `DevAuthProvider`, pour que
 * `AuthGuard`/`PrivilegesGuard` et la forme de `AuthenticatedUser`/`GET /me`
 * restent inchangés.
 *
 * Contrôles (SEC-24, revue sécurité 2026-10-19) :
 *  - signature RS256, émetteur, expiration (`jsonwebtoken.verify`) ;
 *  - `typ === 'Bearer'` (refuse les ID tokens et refresh tokens) ;
 *  - client OBLIGATOIRE : `azp` présent et dans la liste autorisée, ou à
 *    défaut `aud` contenant un client autorisé — liste issue de la
 *    configuration (`KEYCLOAK_ALLOWED_CLIENTS`, défaut `KEYCLOAK_CLIENT_ID`),
 *    plus aucun client codé en dur ;
 *  - rôle applicatif UNIQUE : claim `ida_place_role` si présente (règle
 *    explicite, doit être un rôle connu), sinon EXACTEMENT un rôle applicatif
 *    dans `realm_access.roles` — un jeton portant plusieurs rôles applicatifs
 *    est refusé (plus de `ROLES.find` arbitraire) ;
 *  - `email_verified === true` exigé ;
 *  - JWKS via `jwks-rsa` : cache (10 min), limite de débit (10 appels/min),
 *    délai d'attente (5 s) ; `kid` et `alg` contrôlés avant tout appel.
 *
 * Compte applicatif (SEC-09) : `PlaceUserDirectory.lookupAccount` à chaque
 * requête — compte SUSPENDU → 401 ; compte lié à un autre `sub` → 401 ;
 * compte actif → dérogations grant/revoke appliquées ; compte inconnu (miroir
 * non synchronisé) → rôle du jeton seul.
 *
 * Testable SANS serveur Keycloak réel : le `fetcher` de `jwks-rsa` utilise
 * le `fetch` global (mockable, voir `keycloak.strategy.spec.ts`).
 */
@Injectable()
export class KeycloakStrategy implements AuthProvider {
  private readonly logger = new Logger('KeycloakStrategy');
  private jwks?: { uri: string; client: JwksClient };

  constructor(
    private readonly rbac: RbacService,
    private readonly directory: PlaceUserDirectory,
  ) {}

  private get baseUrl(): string | undefined {
    return process.env.KEYCLOAK_BASE_URL;
  }

  private get realm(): string | undefined {
    return process.env.KEYCLOAK_REALM;
  }

  private get issuer(): string | undefined {
    return this.baseUrl && this.realm ? `${this.baseUrl.replace(/\/$/, '')}/realms/${this.realm}` : undefined;
  }

  private get jwksUrl(): string | undefined {
    return this.issuer ? `${this.issuer}/protocol/openid-connect/certs` : undefined;
  }

  /** Clients OIDC autorisés (`azp`/`aud`) — configuration uniquement. */
  allowedClients(): string[] {
    const raw = process.env.KEYCLOAK_ALLOWED_CLIENTS ?? process.env.KEYCLOAK_CLIENT_ID ?? '';
    return raw
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
  }

  /**
   * Configuration minimale requise pour vérifier un JWT Keycloak. Appelée
   * par `auth.module.ts` UNIQUEMENT quand `AUTH_PROVIDER=keycloak` est
   * effectivement sélectionné : ne doit jamais casser le mode dev par un
   * throw de constructeur.
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

  private jwksClient(): JwksClient {
    const uri = this.jwksUrl;
    if (!uri) throw new Error('KeycloakStrategy: KEYCLOAK_BASE_URL/KEYCLOAK_REALM manquants.');
    if (!this.jwks || this.jwks.uri !== uri) {
      this.jwks = {
        uri,
        client: new JwksClient({
          jwksUri: uri,
          cache: true,
          cacheMaxEntries: 10,
          cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
          rateLimit: true,
          jwksRequestsPerMinute: JWKS_REQUESTS_PER_MINUTE,
          timeout: JWKS_TIMEOUT_MS,
          fetcher: async (jwksUri: string) => {
            const res = await fetch(jwksUri, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
            if (!res.ok) throw new Error(`échec de récupération du JWKS (${res.status})`);
            return (await res.json()) as { keys: unknown[] };
          },
        }),
      };
    }
    return this.jwks.client;
  }

  private async resolvePublicKey(kid: string): Promise<string> {
    const key = await this.jwksClient().getSigningKey(kid);
    return key.getPublicKey();
  }

  /** Rôle applicatif unique (voir doc de classe) — `undefined` si absent, inconnu ou ambigu. */
  private extractRole(payload: KeycloakTokenPayload): Role | undefined {
    if (payload.ida_place_role !== undefined) {
      return (ROLES as readonly string[]).includes(payload.ida_place_role) ? (payload.ida_place_role as Role) : undefined;
    }
    const realmRoles = Array.isArray(payload.realm_access?.roles) ? payload.realm_access!.roles : [];
    const appRoles = ROLES.filter((r) => realmRoles.includes(r));
    return appRoles.length === 1 ? appRoles[0] : undefined;
  }

  private clientAllowed(payload: KeycloakTokenPayload): boolean {
    const allowed = this.allowedClients();
    if (allowed.length === 0) return false;
    if (typeof payload.azp === 'string' && payload.azp.length > 0) return allowed.includes(payload.azp);
    const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    return aud.some((a) => allowed.includes(a));
  }

  async resolve(req: { headers: Record<string, unknown> }): Promise<AuthenticatedUser | null> {
    this.assertConfigured();

    const authz = req.headers['authorization'];
    if (typeof authz !== 'string' || !authz.startsWith('Bearer ')) return null;
    const token = authz.slice(7);

    const decoded = jwt.decode(token, { complete: true });
    const header = decoded && typeof decoded === 'object' ? (decoded.header as { kid?: unknown; alg?: unknown }) : undefined;
    const kid = header?.kid;
    if (typeof kid !== 'string' || !KID_PATTERN.test(kid)) {
      this.logger.warn('JWT Keycloak sans "kid" valide dans son en-tête — rejeté.');
      return null;
    }
    if (header?.alg !== 'RS256') {
      this.logger.warn(`JWT Keycloak avec un algorithme inattendu ("${sanitizeForLog(header?.alg, 20)}") — rejeté.`);
      return null;
    }

    let publicKey: string;
    try {
      publicKey = await this.resolvePublicKey(kid);
    } catch (err) {
      // SEC-45 : `kid` et message neutralisés avant journalisation.
      this.logger.warn(`Clé JWKS introuvable ou indisponible pour kid="${sanitizeForLog(kid, 128)}" (${sanitizeForLog(err)}).`);
      return null;
    }

    let payload: KeycloakTokenPayload;
    try {
      payload = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: this.issuer }) as KeycloakTokenPayload;
    } catch (err) {
      this.logger.warn(`JWT Keycloak invalide (${sanitizeForLog(err)}).`);
      return null;
    }

    if (payload.typ !== 'Bearer') {
      this.logger.warn(`JWT Keycloak de type "${sanitizeForLog(payload.typ ?? '', 20)}" (Bearer attendu) — rejeté.`);
      return null;
    }
    if (!this.clientAllowed(payload)) {
      this.logger.warn(`JWT Keycloak sans client autorisé (azp="${sanitizeForLog(payload.azp ?? '', 64)}") — rejeté.`);
      return null;
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      this.logger.warn('JWT Keycloak sans "sub" — rejeté.');
      return null;
    }
    if (payload.email_verified !== true) {
      this.logger.warn('JWT Keycloak dont l\'e-mail n\'est pas vérifié (email_verified) — rejeté.');
      return null;
    }

    const role = this.extractRole(payload);
    if (!role) {
      this.logger.warn('JWT Keycloak sans rôle applicatif unique reconnu (ida_place_role / realm_access.roles) — rejeté.');
      return null;
    }

    const email = payload.email ?? '';
    const account = await this.directory.lookupAccount({ sub: payload.sub, email, emailVerified: true });
    if (account.status === 'INACTIVE') {
      this.logger.warn(`Authentification refusée : compte applicatif suspendu (${account.userId}).`);
      return null;
    }
    if (account.status === 'SUB_MISMATCH') {
      this.logger.warn(`Authentification refusée : le compte applicatif ${account.userId} est lié à une autre identité Keycloak.`);
      return null;
    }
    const grant = account.status === 'ACTIVE' ? account.grant : [];
    const revoke = account.status === 'ACTIVE' ? account.revoke : [];
    const privileges = this.rbac.effectivePrivileges(role, grant, revoke);

    return {
      id: payload.sub,
      name: payload.name ?? payload.preferred_username ?? payload.sub,
      email,
      role,
      companyId: payload.company_id,
      privileges,
      ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp * 1000 } : {}),
    };
  }
}
