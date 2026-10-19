import { BadRequestException, Injectable } from '@nestjs/common';
import {
  DEFAULT_ROLE_MATRIX,
  forbiddenPrivilegesForRole,
  isCompanyScopedRole,
  PLACE_RESERVED_PRIVILEGES,
  Privilege,
  PRIVILEGES,
  Role,
  ROLES,
  RoleMatrix,
} from './roles-privileges';

/** Une modification unitaire de la matrice (pour la journalisation, SEC-25). */
export interface RoleMatrixChange {
  role: Role;
  privilege: Privilege;
  from: boolean;
  to: boolean;
}

/**
 * Détenteur runtime de la matrice rôles × privilèges (miroir applicatif de
 * Keycloak, cf. B.7). Stockage en mémoire pour ce socle : la persistance
 * (entité + migration + règle des quatre yeux) reste à faire — voir le
 * rapport SEC-25. Chaque modification est en revanche JOURNALISÉE dans le
 * journal scellé par `AdminController` (`LedgerService.append`).
 */
@Injectable()
export class RbacService {
  private matrix: RoleMatrix = structuredClone(DEFAULT_ROLE_MATRIX);

  getMatrix(): RoleMatrix {
    return this.matrix;
  }

  /**
   * Valide un patch de matrice SANS l'appliquer et renvoie la liste des
   * changements effectifs. Lève 400 si :
   *  - rôle/privilège inconnu ou valeur non booléenne (revue 2026-10-18 :
   *    le payload n'était validé par aucun DTO de classe) ;
   *  - SEC-25 : un privilège réservé à la place serait ACCORDÉ à un rôle de
   *    `COMPANY_SCOPED_ROLES` (plancher de séparation des tâches).
   */
  previewMatrixChange(next: unknown): RoleMatrixChange[] {
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Matrice invalide : objet { rôle: { privilège: booléen } } attendu.' });
    }
    const changes: RoleMatrixChange[] = [];
    for (const [role, privileges] of Object.entries(next as Record<string, unknown>)) {
      if (!(ROLES as readonly string[]).includes(role)) {
        throw new BadRequestException({ code: 'BAD_REQUEST', message: `Rôle inconnu dans la matrice: "${role}".` });
      }
      if (privileges === null || typeof privileges !== 'object' || Array.isArray(privileges)) {
        throw new BadRequestException({ code: 'BAD_REQUEST', message: `Privilèges invalides pour le rôle "${role}".` });
      }
      for (const [privilege, value] of Object.entries(privileges as Record<string, unknown>)) {
        if (!(PRIVILEGES as readonly string[]).includes(privilege)) {
          throw new BadRequestException({ code: 'BAD_REQUEST', message: `Privilège inconnu: "${privilege}".` });
        }
        if (typeof value !== 'boolean') {
          throw new BadRequestException({ code: 'BAD_REQUEST', message: `Valeur non booléenne pour "${role}.${privilege}".` });
        }
        if (value && forbiddenPrivilegesForRole(role, [privilege]).length > 0) {
          throw new BadRequestException({
            code: 'PRIVILEGE_RESERVE_PLACE',
            message: `Le privilège "${privilege}" est réservé aux rôles de place : il ne peut pas être accordé au rôle "${role}".`,
          });
        }
        const from = this.matrix[role as Role]?.[privilege as Privilege] ?? false;
        if (from !== value) changes.push({ role: role as Role, privilege: privilege as Privilege, from, to: value });
      }
    }
    return changes;
  }

  /**
   * Fusionne par rôle puis par privilège plutôt que de remplacer la matrice
   * en bloc : un payload partiel ne doit JAMAIS faire perdre leurs privilèges
   * aux autres rôles (bug corrigé en revue Testeur, sprint 3). Validation
   * complète via `previewMatrixChange` (protège tout appelant interne).
   */
  setMatrix(next: Partial<RoleMatrix>): RoleMatrixChange[] {
    const changes = this.previewMatrixChange(next);
    const merged = { ...this.matrix };
    for (const role of Object.keys(next) as Role[]) {
      merged[role] = { ...merged[role], ...next[role] };
    }
    this.matrix = merged;
    return changes;
  }

  /**
   * Privilèges effectifs d'un utilisateur = matrice du rôle, modulo les
   * dérogations grant/revoke propres à l'utilisateur. `AUDITEUR_CSA` reste
   * toujours lecture seule (règle explicite B.7). SEC-25 : un rôle de
   * compagnie ne reçoit JAMAIS un privilège réservé à la place, quelle que
   * soit l'origine (matrice, dérogation, en-tête de développement).
   */
  effectivePrivileges(role: Role, grant: Privilege[] = [], revoke: Privilege[] = []): Privilege[] {
    if (role === 'AUDITEUR_CSA') return [];
    const base = new Set<Privilege>(PRIVILEGES.filter((p) => this.matrix[role]?.[p]));
    for (const g of grant) if ((PRIVILEGES as readonly string[]).includes(g)) base.add(g);
    for (const r of revoke) base.delete(r);
    if (isCompanyScopedRole(role)) for (const p of PLACE_RESERVED_PRIVILEGES) base.delete(p);
    return [...base];
  }
}
