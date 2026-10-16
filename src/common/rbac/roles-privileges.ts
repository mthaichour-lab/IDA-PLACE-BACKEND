/**
 * Modèle RBAC — Partie B.7 du dossier technique.
 *
 * Source d'autorité en production : Keycloak (realm "ida-place", rôles +
 * groupes). Ce fichier définit le MIROIR applicatif (matrice rôles ×
 * privilèges) que `RbacService` expose et que l'écran 14 (Paramétrage ›
 * Rôles & privilèges) permet d'éditer. `AUDITEUR_CSA` reste toujours en
 * lecture seule, quelles que soient les cases de la matrice (règle B.7).
 */

export const ROLES = [
  'OPERATEUR_PLACE',
  'ADMIN_UAR',
  'MEMBRE_COMMISSION',
  'CORRESPONDANT_IDA',
  'TRESORIER',
  'AUDITEUR_CSA',
] as const;
export type Role = (typeof ROLES)[number];

export const PRIVILEGES = [
  'admin',
  'matchDecide',
  'seal',
  'synth',
  'remind',
  'pvSign',
  'pay',
  'penaltyOrder',
  'decide',
  'sanction',
  'params',
  'grid',
  'exchange',
  'insert',
  'refedit',
  'import',
  'bill',
] as const;
export type Privilege = (typeof PRIVILEGES)[number];

export type RoleMatrix = Record<Role, Record<Privilege, boolean>>;

function row(on: Privilege[]): Record<Privilege, boolean> {
  const r = {} as Record<Privilege, boolean>;
  for (const p of PRIVILEGES) r[p] = on.includes(p);
  return r;
}

/** Matrice par défaut (éditable au runtime via AdminModule / écran 14). */
export const DEFAULT_ROLE_MATRIX: RoleMatrix = {
  OPERATEUR_PLACE: row([...PRIVILEGES]), // super admin opérateur (GIE FinLab)
  ADMIN_UAR: row([...PRIVILEGES]), // super admin réglementaire
  MEMBRE_COMMISSION: row(['decide', 'sanction', 'penaltyOrder', 'pvSign', 'synth']),
  CORRESPONDANT_IDA: row(['matchDecide', 'exchange', 'insert', 'import', 'refedit', 'remind', 'synth']),
  TRESORIER: row(['pay', 'bill', 'synth']),
  AUDITEUR_CSA: row([]), // lecture seule imposée par la garde, indépendamment de la matrice
};

/** Entreprises/organisations rattachées à un rôle "place" (pas de tenant). */
export const PLACE_LEVEL_ROLES: Role[] = ['OPERATEUR_PLACE', 'ADMIN_UAR', 'MEMBRE_COMMISSION', 'AUDITEUR_CSA'];

/** Rôles rattachés obligatoirement à une compagnie (scoping tenant). */
export const COMPANY_SCOPED_ROLES: Role[] = ['CORRESPONDANT_IDA', 'TRESORIER'];
