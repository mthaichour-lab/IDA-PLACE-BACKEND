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
  // QUESTIONS_UAR.md §11, décision Product Owner 2026-10-18 : clôture de la
  // compensation TRIMESTRIELLE (`POST /settlement/quarter/:q/close`),
  // action place-entière et irréversible (pas de paramètre compagnie,
  // contrairement à `closeMonthly`) — réservée aux rôles "place"
  // (OPERATEUR_PLACE/ADMIN_UAR/MEMBRE_COMMISSION). Privilège DÉDIÉ plutôt
  // que de réutiliser `synth` (qui reste nécessaire pour la LECTURE des
  // synthèses mensuelles/trimestrielles par CORRESPONDANT_IDA/TRESORIER,
  // voir `DEFAULT_ROLE_MATRIX` ci-dessous et `settlement.controller.ts`).
  'closeQuarter',
  // QUESTIONS_UAR.md §12, décision Product Owner 2026-10-18 : onboarding
  // d'une NOUVELLE compagnie adhérente (`POST /referential/companies`),
  // distinct de `updateCompany`/`createAgency`/experts (qui restent sur
  // `refedit`, un correspondant agissant sur SA PROPRE compagnie déjà
  // adhérente) — un onboarding n'a pas de "propriétaire existant" à
  // vérifier, réservé aux rôles "place" (OPERATEUR_PLACE/ADMIN_UAR).
  'onboardCompany',
  // Adhésions et retraits (Chapitre VI, Art. 30-35) : demandes adressées à
  // l'UAR, instruites par les rôles "place" OPERATEUR_PLACE/ADMIN_UAR.
  'membership',
  // Validation UAR des référentiels de place (motifs d'opposition,
  // circonstances du constat, référence IRSAM) — décision PO points 1-4.
  'validateRef',
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
  // Tout sauf `validateRef` : les paramètres conventionnels sont confiés à
  // l'Admin UAR (guide illustré, rôle « Admin UAR »).
  OPERATEUR_PLACE: row(PRIVILEGES.filter((p) => p !== 'validateRef')), // super admin opérateur (GIE FinLab)
  ADMIN_UAR: row([...PRIVILEGES]), // super admin réglementaire
  // §11 : MEMBRE_COMMISSION tient explicitement 'closeQuarter' (rôle
  // "place" légitime pour la clôture trimestrielle place-entière).
  MEMBRE_COMMISSION: row(['decide', 'sanction', 'penaltyOrder', 'pvSign', 'synth', 'closeQuarter']),
  // §11/§12 : ni 'closeQuarter' ni 'onboardCompany' ici — CORRESPONDANT_IDA
  // garde 'refedit' pour updateCompany/createAgency/experts (sa PROPRE
  // compagnie), mais ne peut plus clôturer la place entière ni onboarder un
  // nouvel adhérent (voir settlement.controller.ts/adherents.controller.ts).
  CORRESPONDANT_IDA: row(['matchDecide', 'exchange', 'insert', 'import', 'refedit', 'remind', 'synth']),
  TRESORIER: row(['pay', 'bill', 'synth']),
  AUDITEUR_CSA: row([]), // lecture seule imposée par la garde, indépendamment de la matrice
};

/** Entreprises/organisations rattachées à un rôle "place" (pas de tenant). */
export const PLACE_LEVEL_ROLES: Role[] = ['OPERATEUR_PLACE', 'ADMIN_UAR', 'MEMBRE_COMMISSION', 'AUDITEUR_CSA'];

/** Rôles rattachés obligatoirement à une compagnie (scoping tenant). */
export const COMPANY_SCOPED_ROLES: Role[] = ['CORRESPONDANT_IDA', 'TRESORIER'];

/**
 * SEC-25 (revue sécurité 2026-10-19) — privilèges RÉSERVÉS À LA PLACE :
 * administration, gouvernance, décision/sanction de commission, clôtures,
 * paramètres conventionnels, onboarding/adhésions, scellement. Plancher
 * absolu : aucun rôle de `COMPANY_SCOPED_ROLES` ne peut les détenir, ni par
 * la matrice (`RbacService.setMatrix`), ni par une dérogation `grant`
 * individuelle (`PlaceUserDirectory`), ni au calcul des privilèges effectifs
 * (`RbacService.effectivePrivileges`, défense en profondeur). Une compagnie
 * ne peut donc jamais juger, sanctionner ou clôturer ses propres dossiers.
 *
 * Les autres privilèges (`matchDecide`, `exchange`, `insert`, `import`,
 * `refedit`, `remind`, `synth`, `pay`, `bill`) sont des actions qu'une
 * compagnie exerce sur SES propres données (scoping tenant des services).
 */
export const PLACE_RESERVED_PRIVILEGES: readonly Privilege[] = [
  'admin',
  'seal',
  'pvSign',
  'penaltyOrder',
  'decide',
  'sanction',
  'params',
  'grid',
  'closeQuarter',
  'onboardCompany',
  'membership',
  'validateRef',
];

export function isCompanyScopedRole(role: string): boolean {
  return (COMPANY_SCOPED_ROLES as readonly string[]).includes(role);
}

/** Privilèges de `privileges` interdits au rôle `role` (vide si le rôle est un rôle de place). */
export function forbiddenPrivilegesForRole(role: string, privileges: readonly string[]): Privilege[] {
  if (!isCompanyScopedRole(role)) return [];
  return privileges.filter((p): p is Privilege => (PLACE_RESERVED_PRIVILEGES as readonly string[]).includes(p));
}
