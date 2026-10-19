/**
 * Référentiels de place (écran 12) — décisions PO points 1 à 4.
 *
 * Origine des valeurs pré-remplies : uniquement (a) documents UAR et (b)
 * connaissance publique. Les tables `mobile_holiday` (dates),
 * `wilaya_population` et `irsam_benchmark` ne sont JAMAIS pré-remplies.
 */

export const MOBILE_HOLIDAY_KINDS = ['AWAL_MOHARRAM', 'ACHOURA', 'MAWLID_ENNABAOUI', 'AID_EL_FITR', 'AID_EL_ADHA'] as const;
export type MobileHolidayKind = (typeof MOBILE_HOLIDAY_KINDS)[number];

// Libellés de la loi 63-278 modifiée (origine (b), confiance haute). Aucune date.
export const MOBILE_HOLIDAY_KIND_LABELS: Record<MobileHolidayKind, string> = {
  AWAL_MOHARRAM: 'Awal Moharram',
  ACHOURA: 'Achoura',
  MAWLID_ENNABAOUI: 'Mawlid Ennabaoui',
  AID_EL_FITR: 'Aïd el-Fitr',
  AID_EL_ADHA: 'Aïd el-Adha',
};

export const MOBILE_HOLIDAY_STATUSES = ['PREVISIONNEL', 'CONFIRME'] as const;
export type MobileHolidayStatus = (typeof MOBILE_HOLIDAY_STATUSES)[number];

export const CONSTAT_CIRCUMSTANCE_STATUSES = ['STANDARD_A_CONFIRMER', 'VALIDE_UAR'] as const;
export type ConstatCircumstanceStatus = (typeof CONSTAT_CIRCUMSTANCE_STATUSES)[number];

export const OPPOSITION_MOTIF_STATUSES = ['SAISI', 'VALIDE_UAR'] as const;
export type OppositionMotifStatus = (typeof OPPOSITION_MOTIF_STATUSES)[number];

export const POPULATION_SOURCE_TYPES = ['RECENSEMENT_RGPH', 'ESTIMATION_ONS', 'AUTRE'] as const;
export type PopulationSourceType = (typeof POPULATION_SOURCE_TYPES)[number];

export const IRSAM_INDICATORS = ['DELAI_MOYEN_REGLEMENT_RECOURS_JOURS'] as const;
export type IrsamIndicator = (typeof IRSAM_INDICATORS)[number];

export const IRSAM_STATUSES = ['SAISI', 'VALIDE_UAR', 'ARCHIVE'] as const;
export type IrsamStatus = (typeof IRSAM_STATUSES)[number];

// Barème Art. 14 et catégories de véhicule (§5) : origine (c), aucune valeur pré-remplie.
export const BAREME_VERSION_STATUSES = ['BROUILLON', 'VALIDE_UAR', 'ARCHIVE'] as const;
export type BaremeVersionStatus = (typeof BAREME_VERSION_STATUSES)[number];

export const VEHICLE_CATEGORY_STATUSES = ['SAISI', 'VALIDE_UAR'] as const;
export type VehicleCategoryStatus = (typeof VEHICLE_CATEGORY_STATUSES)[number];

export const CONSTAT_CIRCUMSTANCE_MIN = 1;
export const CONSTAT_CIRCUMSTANCE_MAX = 17;

/** Auteur des lignes pré-remplies : jamais un utilisateur réel, donc la règle des quatre yeux reste satisfaite. */
export const SEED_AUTHOR = 'system:seed';

/**
 * Les 17 circonstances du constat amiable européen (modèle CEA), transposé en
 * Algérie — origine (b) : confiance haute sur la structure, moyenne sur la
 * formulation, d'où le statut `STANDARD_A_CONFIRMER`. Libellés arabes : (c).
 * Dupliqué volontairement dans Migration20261018030000 (une migration est figée).
 */
export const CONSTAT_CIRCUMSTANCES_SEED: ReadonlyArray<{ number: number; labelFr: string }> = [
  { number: 1, labelFr: "en stationnement / à l'arrêt" },
  { number: 2, labelFr: "quittait un stationnement / ouvrait une portière" },
  { number: 3, labelFr: "prenait un stationnement" },
  { number: 4, labelFr: "sortait d'un parking, d'un lieu privé, d'un chemin de terre" },
  { number: 5, labelFr: "s'engageait dans un parking, un lieu privé, un chemin de terre" },
  { number: 6, labelFr: "s'engageait sur une place à sens giratoire" },
  { number: 7, labelFr: "roulait sur une place à sens giratoire" },
  { number: 8, labelFr: "heurtait à l'arrière, en roulant dans le même sens et sur une même file" },
  { number: 9, labelFr: "roulait dans le même sens et sur une file différente" },
  { number: 10, labelFr: "changeait de file" },
  { number: 11, labelFr: "doublait" },
  { number: 12, labelFr: "virait à droite" },
  { number: 13, labelFr: "virait à gauche" },
  { number: 14, labelFr: "reculait" },
  { number: 15, labelFr: "empiétait sur une voie réservée à la circulation en sens inverse" },
  { number: 16, labelFr: "venait de droite (dans un carrefour)" },
  { number: 17, labelFr: "n'avait pas observé un signal de priorité ou un feu rouge" },
];

export const NON_DECLARATION_MOTIF_CODE = 'NON_DECLARATION';

/** Origine (a) : guide pédagogique UAR, diapo 10 — « La non-déclaration ne peut jamais motiver une opposition. » */
export const OPPOSITION_MOTIFS_SEED: ReadonlyArray<{ code: string; label: string; forbidden: boolean; sourceRef: string }> = [
  {
    code: NON_DECLARATION_MOTIF_CODE,
    label: 'Non-déclaration du sinistre',
    forbidden: true,
    sourceRef: 'Guide pédagogique UAR, diapo 10 (Art. 10)',
  },
];
