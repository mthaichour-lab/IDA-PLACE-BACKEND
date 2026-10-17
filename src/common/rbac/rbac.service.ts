import { Injectable } from '@nestjs/common';
import {
  DEFAULT_ROLE_MATRIX,
  Privilege,
  PRIVILEGES,
  Role,
  RoleMatrix,
} from './roles-privileges';

/**
 * Détenteur runtime de la matrice rôles × privilèges (miroir applicatif de
 * Keycloak, cf. B.7). Stockage en mémoire pour ce socle : le futur agent
 * Backend branchera la persistance réelle (entité `RolePermMatrix`,
 * migration MikroORM) sans changer la forme de l'API `/admin/roles/matrix`.
 */
@Injectable()
export class RbacService {
  private matrix: RoleMatrix = structuredClone(DEFAULT_ROLE_MATRIX);

  getMatrix(): RoleMatrix {
    return this.matrix;
  }

  /**
   * Fusionne par rôle puis par privilège plutôt que de remplacer la matrice
   * en bloc : un payload partiel (un seul rôle, ou un rôle avec seulement
   * quelques privilèges) ne doit JAMAIS faire perdre leurs privilèges aux
   * autres rôles. Bug trouvé en revue Testeur, sprint 3 : `this.matrix = next`
   * provoquait un verrouillage RBAC complet dès qu'un payload partiel était
   * envoyé (même défaut que `MeteringService.updateGrid`, voir ce fichier).
   */
  setMatrix(next: Partial<RoleMatrix>): void {
    const merged = { ...this.matrix };
    for (const role of Object.keys(next) as Role[]) {
      merged[role] = { ...merged[role], ...next[role] };
    }
    this.matrix = merged;
  }

  /**
   * Privilèges effectifs d'un utilisateur = matrice du rôle, modulo les
   * dérogations grant/revoke propres à l'utilisateur. `AUDITEUR_CSA` reste
   * toujours lecture seule (aucun privilège d'écriture effectif), quelles
   * que soient les dérogations — règle explicite B.7.
   */
  effectivePrivileges(role: Role, grant: Privilege[] = [], revoke: Privilege[] = []): Privilege[] {
    if (role === 'AUDITEUR_CSA') return [];
    const base = new Set<Privilege>(PRIVILEGES.filter((p) => this.matrix[role]?.[p]));
    for (const g of grant) base.add(g);
    for (const r of revoke) base.delete(r);
    return [...base];
  }
}
