/**
 * Modèle d'échange 47 colonnes — B.4 "Modèle d'échange".
 *
 * Contrat d'import stable : 25 colonnes d'identification + 22 colonnes
 * servant à l'éligibilité IDA. Le dossier technique ne fournit qu'un
 * extrait de noms de colonnes ; cette liste complète les 47 colonnes de
 * façon cohérente avec l'extrait donné (B.4) et les règles d'éligibilité
 * (B.6). ⚠️ Elle fixe le CONTRAT final : ne plus renommer/retirer de
 * colonnes ici — le parsing Excel (`exceljs`)/CSV réel (`claims.service.ts`)
 * en dépend.
 */
export type ClaimColumnGroup = 'IDENTIFICATION' | 'ELIGIBILITE';

export interface ClaimColumnDef {
  index: number; // 1..47
  key: string;
  label: string;
  group: ClaimColumnGroup;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'string[]';
  enumValues?: string[];
}

export const CLAIM_IMPORT_COLUMNS: ClaimColumnDef[] = [
  // --- Identification (25) ---
  { index: 1, key: 'numEconstat', label: 'N° e-constat', group: 'IDENTIFICATION', type: 'string' },
  { index: 2, key: 'dateDeclaration', label: 'Date de déclaration', group: 'IDENTIFICATION', type: 'date' },
  { index: 3, key: 'dateDemandeRecours', label: 'Date demande de recours', group: 'IDENTIFICATION', type: 'date' },
  { index: 4, key: 'nombreVehicules', label: 'Nombre de véhicules impliqués', group: 'IDENTIFICATION', type: 'number' },
  { index: 5, key: 'territoire', label: 'Territoire', group: 'IDENTIFICATION', type: 'enum', enumValues: ['ALGERIE', 'ETRANGER'] },
  { index: 6, key: 'wilaya', label: 'Wilaya', group: 'IDENTIFICATION', type: 'string' },
  { index: 7, key: 'commune', label: 'Commune', group: 'IDENTIFICATION', type: 'string' },
  { index: 8, key: 'dateAccident', label: "Date de l'accident", group: 'IDENTIFICATION', type: 'date' },
  { index: 9, key: 'heureAccident', label: "Heure de l'accident", group: 'IDENTIFICATION', type: 'string' },
  { index: 10, key: 'lieuAccident', label: "Lieu de l'accident", group: 'IDENTIFICATION', type: 'string' },
  { index: 11, key: 'gpsLat', label: 'GPS latitude', group: 'IDENTIFICATION', type: 'number' },
  { index: 12, key: 'gpsLng', label: 'GPS longitude', group: 'IDENTIFICATION', type: 'number' },
  { index: 13, key: 'compagnieA', label: 'Compagnie A (code)', group: 'IDENTIFICATION', type: 'string' },
  { index: 14, key: 'numAttestationA', label: 'N° attestation A', group: 'IDENTIFICATION', type: 'string' },
  { index: 15, key: 'validiteADebut', label: 'Validité A début', group: 'IDENTIFICATION', type: 'date' },
  { index: 16, key: 'validiteAFin', label: 'Validité A fin', group: 'IDENTIFICATION', type: 'date' },
  { index: 17, key: 'garantieA', label: 'Garantie A', group: 'IDENTIFICATION', type: 'string' },
  { index: 18, key: 'conducteurAEstAssure', label: 'Conducteur A = assuré', group: 'IDENTIFICATION', type: 'boolean' },
  { index: 19, key: 'immatriculationA', label: 'Immatriculation A', group: 'IDENTIFICATION', type: 'string' },
  { index: 20, key: 'compagnieB', label: 'Compagnie B (code)', group: 'IDENTIFICATION', type: 'string' },
  { index: 21, key: 'numAttestationB', label: 'N° attestation B', group: 'IDENTIFICATION', type: 'string' },
  { index: 22, key: 'validiteBDebut', label: 'Validité B début', group: 'IDENTIFICATION', type: 'date' },
  { index: 23, key: 'validiteBFin', label: 'Validité B fin', group: 'IDENTIFICATION', type: 'date' },
  { index: 24, key: 'garantieB', label: 'Garantie B', group: 'IDENTIFICATION', type: 'string' },
  { index: 25, key: 'immatriculationB', label: 'Immatriculation B', group: 'IDENTIFICATION', type: 'string' },

  // --- Éligibilité IDA (22) ---
  { index: 26, key: 'conducteurBEstAssure', label: 'Conducteur B = assuré', group: 'ELIGIBILITE', type: 'boolean' },
  { index: 27, key: 'montantEstime', label: 'Montant estimé (DA)', group: 'ELIGIBILITE', type: 'number' },
  { index: 28, key: 'montantExpertise', label: 'Montant expertisé (DA)', group: 'ELIGIBILITE', type: 'number' },
  { index: 29, key: 'exclusions', label: 'Exclusions', group: 'ELIGIBILITE', type: 'string[]' },
  { index: 30, key: 'piecesFournies', label: 'Pièces fournies', group: 'ELIGIBILITE', type: 'string[]' },
  { index: 31, key: 'constatAmiableSigneDeuxParties', label: 'Constat amiable signé par les deux parties', group: 'ELIGIBILITE', type: 'boolean' },
  { index: 32, key: 'responsabiliteDeclareeA', label: 'Responsabilité déclarée A (%)', group: 'ELIGIBILITE', type: 'number' },
  { index: 33, key: 'responsabiliteDeclareeB', label: 'Responsabilité déclarée B (%)', group: 'ELIGIBILITE', type: 'number' },
  { index: 34, key: 'observationsIda', label: 'Observations IDA', group: 'ELIGIBILITE', type: 'string' },
  { index: 35, key: 'dommagesCorporelsDeclares', label: 'Dommages corporels déclarés', group: 'ELIGIBILITE', type: 'boolean' },
  { index: 36, key: 'adversePartieAdherente', label: 'Partie adverse adhérente IDA', group: 'ELIGIBILITE', type: 'boolean' },
  { index: 37, key: 'adversePartieActive', label: 'Partie adverse active (non exclue)', group: 'ELIGIBILITE', type: 'boolean' },
  { index: 38, key: 'vehiculeAImmobilise', label: 'Véhicule A immobilisé', group: 'ELIGIBILITE', type: 'boolean' },
  { index: 39, key: 'vehiculeBImmobilise', label: 'Véhicule B immobilisé', group: 'ELIGIBILITE', type: 'boolean' },
  { index: 40, key: 'expertDesigne', label: 'Expert désigné', group: 'ELIGIBILITE', type: 'string' },
  { index: 41, key: 'dateExpertise', label: "Date d'expertise", group: 'ELIGIBILITE', type: 'date' },
  { index: 42, key: 'numPoliceA', label: 'N° police A', group: 'ELIGIBILITE', type: 'string' },
  { index: 43, key: 'numPoliceB', label: 'N° police B', group: 'ELIGIBILITE', type: 'string' },
  { index: 44, key: 'assureAIdentite', label: 'Identité assuré A', group: 'ELIGIBILITE', type: 'string' },
  { index: 45, key: 'assureBIdentite', label: 'Identité assuré B', group: 'ELIGIBILITE', type: 'string' },
  { index: 46, key: 'telephoneAssureA', label: 'Téléphone assuré A', group: 'ELIGIBILITE', type: 'string' },
  { index: 47, key: 'canalDeclaration', label: 'Canal de déclaration', group: 'ELIGIBILITE', type: 'enum', enumValues: ['ERP', 'ECONSTAT', 'IMPORT', 'API'] },
];

if (CLAIM_IMPORT_COLUMNS.length !== 47) {
  throw new Error(`CLAIM_IMPORT_COLUMNS doit contenir exactement 47 colonnes (actuel: ${CLAIM_IMPORT_COLUMNS.length}).`);
}
