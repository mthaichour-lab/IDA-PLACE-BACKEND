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

  setMatrix(next: RoleMatrix): void {
    this.matrix = next;
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
