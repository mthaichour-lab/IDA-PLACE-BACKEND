import { CLAIM_IMPORT_COLUMNS, ClaimColumnDef } from './claim-47-columns';

/**
 * Colonnes d'extension 48-53 — barème Art. 14 (décision PO §5). Tableau
 * séparé : les 47 colonnes et leur garde-fou ne bougent pas, et un fichier à
 * 47 colonnes reste valide (parseur positionnel, cellules absentes = vides).
 */
export interface ClaimExtensionColumnDef extends Omit<ClaimColumnDef, 'group' | 'type'> {
  group: 'BAREME_ART14';
  type: 'circonstances' | 'string';
}

export const CLAIM_IMPORT_EXTENSION_COLUMNS: ClaimExtensionColumnDef[] = [
  { index: 48, key: 'circonstancesA', label: 'Circonstances A (cases 1 à 17 séparées par |)', group: 'BAREME_ART14', type: 'circonstances' },
  { index: 49, key: 'circonstancesB', label: 'Circonstances B (cases 1 à 17 séparées par |)', group: 'BAREME_ART14', type: 'circonstances' },
  { index: 50, key: 'baremeVersion', label: 'Version du barème (libellé ou id)', group: 'BAREME_ART14', type: 'string' },
  { index: 51, key: 'baremeCode', label: 'Code barème Art. 14', group: 'BAREME_ART14', type: 'string' },
  { index: 52, key: 'vehicleCategoryA', label: 'Catégorie véhicule A', group: 'BAREME_ART14', type: 'string' },
  { index: 53, key: 'vehicleCategoryB', label: 'Catégorie véhicule B', group: 'BAREME_ART14', type: 'string' },
];

/** Modèle v2 : les 47 colonnes du modèle v1, inchangées, suivies des colonnes d'extension. */
export const CLAIM_IMPORT_COLUMNS_V2: Array<ClaimColumnDef | ClaimExtensionColumnDef> = [...CLAIM_IMPORT_COLUMNS, ...CLAIM_IMPORT_EXTENSION_COLUMNS];

if (CLAIM_IMPORT_EXTENSION_COLUMNS.some((c, i) => c.index !== CLAIM_IMPORT_COLUMNS.length + 1 + i)) {
  throw new Error('CLAIM_IMPORT_EXTENSION_COLUMNS doit prolonger le modèle 47 colonnes sans trou (48, 49, …).');
}
