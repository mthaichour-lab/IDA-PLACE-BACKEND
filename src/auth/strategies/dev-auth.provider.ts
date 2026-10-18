import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { AuthenticatedUser, AuthProvider } from '../../common/interfaces/authenticated-user.interface';
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
}

/**
 * ⚠️ DEV ONLY — fournisseur d'authentification de développement.
 *
 * Remplace l'intégration OIDC Keycloak réelle (voir `KeycloakStrategy`) dans
 * cet environnement où Keycloak n'est pas disponible. Jamais utilisé en
 * production : activé uniquement par `AUTH_PROVIDER=dev` (défaut en dev).
 *
 * Deux façons de s'identifier :
 *  1. En‑tête `x-dev-user` = nom de rôle (ex: `OPERATEUR_PLACE`) → mappe vers
 *     un utilisateur de démonstration pour ce rôle (pratique pour Swagger /
 *     le front en dev).
 *  2. En‑tête `x-dev-user` = JSON `DevUserPayload` complet, pour simuler un
 *     utilisateur précis (companyId, dérogations grant/revoke...).
 *  3. `Authorization: Bearer <jwt>` signé avec `DEV_JWT_SECRET`, payload =
 *     `DevUserPayload` (utile pour simuler un vrai flux de token côté front).
 *
 * Aucun de ces mécanismes ne doit survivre au remplacement par
 * `KeycloakStrategy` en production.
 */
@Injectable()
export class DevAuthProvider implements AuthProvider {
  private readonly logger = new Logger('DevAuthProvider');

  constructor(private readonly rbac: RbacService) {
    this.logger.warn(
      'AUTH_PROVIDER=dev actif — authentification de démonstration, à ne JAMAIS utiliser en production.',
    );
    // Revue sécurité 2026-10-18 : ce secret signe aussi les jetons des URL
    // pré-signées de LocalFsStorageProvider. La valeur par défaut
    // 'dev-local-only-secret-change-me' est PUBLIQUE (committée dans
    // .env.example) — un avertissement fort plutôt qu'un échec au
    // démarrage, car cet environnement de dev/démo l'utilise tel quel
    // intentionnellement (voir .env) ; la vraie protection est que
    // `AUTH_PROVIDER` doit désormais être EXPLICITEMENT "dev" pour que ce
    // provider soit même sélectionné (voir auth.module.ts).
    if (!process.env.DEV_JWT_SECRET || process.env.DEV_JWT_SECRET === 'dev-local-only-secret-change-me') {
      this.logger.warn(
        'DEV_JWT_SECRET est absent ou vaut la valeur par défaut PUBLIQUE de .env.example — ' +
          'n\'importe qui connaissant ce secret peut forger un jeton dev valide. Change-le si cet environnement est accessible au-delà de ce poste.',
      );
    }
  }

  private demoUser(role: Role): DevUserPayload {
    const demo: Record<Role, DevUserPayload> = {
      OPERATEUR_PLACE: { id: 'dev-op', name: 'Opérateur Place (dev)', email: 'operateur@finlab.dz', role },
      ADMIN_UAR: { id: 'dev-admin-uar', name: 'Admin UAR (dev)', email: 'admin@uar.dz', role },
      MEMBRE_COMMISSION: { id: 'dev-commission', name: 'Membre Commission (dev)', email: 'commission@uar.dz', role },
      // companyId = code compagnie (4 lettres, ex: "CAAT") — même espace de
      // valeurs que Claim.company/counterpartyCompany et Recours.from/to,
      // pour que le scoping tenant (B.7, common/rbac/tenant-scope.ts) soit
      // réellement testable en dev. ⚠️ Bug signalé (non corrigé ailleurs,
      // voir rapport de sprint) : AdminModule.users (mock) utilise encore
      // 'COMP-0001'/'COMP-0002', un espace de valeurs différent qui ne
      // correspond ni à un code compagnie ni à Company.id (uuid) — à
      // harmoniser quand ce module deviendra réel.
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
    const header = req.headers['x-dev-user'] as string | undefined;
    const authz = req.headers['authorization'] as string | undefined;

    let payload: DevUserPayload | null = null;

    if (header) {
      const trimmed = header.trim();
      if ((ROLES as readonly string[]).includes(trimmed)) {
        payload = this.demoUser(trimmed as Role);
      } else {
        try {
          payload = JSON.parse(trimmed) as DevUserPayload;
        } catch {
          this.logger.warn(`En-tête x-dev-user illisible (ni rôle connu ni JSON valide): "${trimmed}"`);
          return null;
        }
      }
    } else if (authz?.startsWith('Bearer ')) {
      try {
        payload = jwt.verify(authz.slice(7), process.env.DEV_JWT_SECRET ?? 'dev-local-only-secret-change-me') as DevUserPayload;
      } catch {
        return null;
      }
    }

    if (!payload || !(ROLES as readonly string[]).includes(payload.role)) return null;

    const privileges = this.rbac.effectivePrivileges(payload.role, payload.grant ?? [], payload.revoke ?? []);

    return {
      id: payload.id,
      name: payload.name,
      email: payload.email,
      role: payload.role,
      companyId: payload.companyId,
      privileges,
    };
  }
}
