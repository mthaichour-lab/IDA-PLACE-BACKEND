import { BadRequestException, Injectable } from '@nestjs/common';
import {
  DEFAULT_ROLE_MATRIX,
  Privilege,
  PRIVILEGES,
  Role,
  ROLES,
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
  /**
   * Revue sécurité 2026-10-18 : AVANT, `next` était un simple type TS inline
   * côté contrôleur (`PUT /admin/roles/matrix`), donc jamais validé par le
   * `ValidationPipe` global (whitelist/transform ne s'appliquent qu'aux DTO
   * de classe) — n'importe quelle clé "rôle"/"privilège" inconnue, ou une
   * valeur non booléenne, polluait silencieusement la matrice en mémoire.
   * Déjà gardé par `@Privileges('admin')` (pas une escalade de privilège en
   * soi), mais c'est la limite de validation d'un objet de config critique
   * — validé ici, au point d'entrée unique de la mutation, plutôt que dans
   * le contrôleur (protège tout futur appelant interne aussi).
   */
  setMatrix(next: Partial<RoleMatrix>): void {
    for (const [role, privileges] of Object.entries(next)) {
      if (!(ROLES as readonly string[]).includes(role)) {
        throw new BadRequestException({ code: 'BAD_REQUEST', message: `Rôle inconnu dans la matrice: "${role}".` });
      }
      if (privileges === null || typeof privileges !== 'object') {
        throw new BadRequestException({ code: 'BAD_REQUEST', message: `Privilèges invalides pour le rôle "${role}".` });
      }
      for (const [privilege, value] of Object.entries(privileges)) {
        if (!(PRIVILEGES as readonly string[]).includes(privilege)) {
          throw new BadRequestException({ code: 'BAD_REQUEST', message: `Privilège inconnu: "${privilege}".` });
        }
        if (typeof value !== 'boolean') {
          throw new BadRequestException({ code: 'BAD_REQUEST', message: `Valeur non booléenne pour "${role}.${privilege}".` });
        }
      }
    }

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
