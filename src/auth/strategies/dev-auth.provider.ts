import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { getDevJwtSecret, isProductionEnv } from '../../common/config/env.validation';
import { AuthenticatedUser, AuthProvider } from '../../common/interfaces/authenticated-user.interface';
import { sanitizeForLog } from '../../common/logging/sanitize-log';
import { RbacService } from '../../common/rbac/rbac.service';
import { Privilege, Role, ROLES } from '../../common/rbac/roles-privileges';

interface DevUserPayload {
  id: string;
  name: string;
  email: string;
  role: Role;
  companyId?: string;
  grant?: Privilege[];
  revoke?: Privilege[];
  exp?: number;
}

/** Taille maximale acceptée pour l'en-tête `x-dev-user` (un JSON utilisateur tient largement dedans). */
const MAX_DEV_HEADER_LENGTH = 2048;

/**
 * ⚠️ DEV ONLY — fournisseur d'authentification de développement.
 *
 * Remplace l'intégration OIDC Keycloak réelle (voir `KeycloakStrategy`) en
 * développement et dans les tests. Interdit en production : `AuthModule`
 * refuse de démarrer si `NODE_ENV=production` et `AUTH_PROVIDER !== 'keycloak'`
 * (SEC-01), et `resolve()` refuse toute requête si `NODE_ENV=production`
 * (défense en profondeur, même si ce provider était instancié).
 *
 * Trois façons de s'identifier :
 *  1. En‑tête `x-dev-user` = nom de rôle (ex: `OPERATEUR_PLACE`) → mappe vers
 *     un utilisateur de démonstration pour ce rôle.
 *  2. En‑tête `x-dev-user` = JSON `DevUserPayload` complet, pour simuler un
 *     utilisateur précis (companyId, dérogations grant/revoke...).
 *  3. `Authorization: Bearer <jwt>` signé avec `DEV_JWT_SECRET` (obligatoire,
 *     sans valeur de repli — SEC-01), payload = `DevUserPayload`.
 */
@Injectable()
export class DevAuthProvider implements AuthProvider {
  private readonly logger = new Logger('DevAuthProvider');

  constructor(private readonly rbac: RbacService) {}

  /** Appelé par `selectAuthProvider` quand ce fournisseur est effectivement sélectionné. */
  announce(): void {
    this.logger.warn('AUTH_PROVIDER=dev actif — authentification de démonstration, interdite en production.');
  }

  private demoUser(role: Role): DevUserPayload {
    const demo: Record<Role, DevUserPayload> = {
      OPERATEUR_PLACE: { id: 'dev-op', name: 'Opérateur Place (dev)', email: 'operateur@finlab.dz', role },
      ADMIN_UAR: { id: 'dev-admin-uar', name: 'Admin UAR (dev)', email: 'admin@uar.dz', role },
      MEMBRE_COMMISSION: { id: 'dev-commission', name: 'Membre Commission (dev)', email: 'commission@uar.dz', role },
      // companyId = code compagnie (4 lettres, ex: "CAAT") — même espace de
      // valeurs que Claim.company/counterpartyCompany et Recours.from/to,
      // pour que le scoping tenant (B.7, common/rbac/tenant-scope.ts) soit
      // réellement testable en dev.
      CORRESPONDANT_IDA: {
        id: 'dev-correspondant',
        name: 'Correspondant IDA (dev)',
        email: 'correspondant@compagnie.dz',
        role,
        companyId: 'CAAT',
      },
      TRESORIER: {
        id: 'dev-tresorier',
        name: 'Trésorier (dev)',
        email: 'tresorier@compagnie.dz',
        role,
        companyId: 'CAAT',
      },
      AUDITEUR_CSA: { id: 'dev-auditeur', name: 'Auditeur CSA (dev)', email: 'auditeur@csa.dz', role },
    };
    return demo[role];
  }

  async resolve(req: { headers: Record<string, unknown> }): Promise<AuthenticatedUser | null> {
    // SEC-01 — défense en profondeur : jamais d'authentification de développement en production.
    if (isProductionEnv()) return null;

    const header = req.headers['x-dev-user'];
    const authz = req.headers['authorization'] as string | undefined;

    let payload: DevUserPayload | null = null;

    if (typeof header === 'string' && header.length > 0) {
      if (header.length > MAX_DEV_HEADER_LENGTH) return null;
      const trimmed = header.trim();
      if ((ROLES as readonly string[]).includes(trimmed)) {
        payload = this.demoUser(trimmed as Role);
      } else {
        try {
          payload = JSON.parse(trimmed) as DevUserPayload;
        } catch {
          // SEC-45 : valeur neutralisée (pas de retour à la ligne injecté dans les journaux).
          this.logger.warn(`En-tête x-dev-user illisible (ni rôle connu ni JSON valide): "${sanitizeForLog(trimmed, 120)}"`);
          return null;
        }
      }
    } else if (authz?.startsWith('Bearer ')) {
      try {
        payload = jwt.verify(authz.slice(7), getDevJwtSecret(), { algorithms: ['HS256'] }) as DevUserPayload;
      } catch {
        return null;
      }
    }

    if (!payload || typeof payload !== 'object' || !(ROLES as readonly string[]).includes(payload.role)) return null;

    const privileges = this.rbac.effectivePrivileges(payload.role, payload.grant ?? [], payload.revoke ?? []);

    return {
      id: payload.id,
      name: payload.name,
      email: payload.email,
      role: payload.role,
      companyId: payload.companyId,
      privileges,
      ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp * 1000 } : {}),
    };
  }
}
