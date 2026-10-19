import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

/**
 * Claim / Declaration — B.3, écrans 2 et 3. Une ligne = une déclaration
 * d'accident telle que déposée par UNE compagnie (modèle 47 colonnes,
 * B.4). Les champs les plus utilisés (identification, montants, critères
 * d'appariement — B.5) sont promus en colonnes typées ; `raw` conserve
 * l'intégralité de la ligne source (47 colonnes, y compris celles qui ne
 * sont pas exploitées ailleurs : expert désigné, identités, observations…)
 * pour audit et ré-évaluation.
 *
 * ⚠️ `numEconstat` n'est PAS unique : deux déclarations (une par compagnie)
 * peuvent légitimement partager le même n° e-constat — c'est précisément la
 * clé d'appariement EXACTE du MatchingModule (B.5).
 */
@Entity({ tableName: 'claim' })
export class Claim {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property({ nullable: true })
  numEconstat?: string;

  /** Compagnie émettrice de CETTE déclaration (code, ex: "CAAT"). */
  @Property({ length: 4 })
  company!: string;

  /** Compagnie de la partie adverse, telle que déclarée (peut différer du vrai appariement). */
  @Property({ nullable: true, length: 4 })
  counterpartyCompany?: string;

  @Property({ type: 'date', nullable: true })
  accidentDate?: string;

  /** Heure locale "HH:mm". */
  @Property({ nullable: true, length: 5 })
  accidentTime?: string;

  @Property({ nullable: true, length: 2 })
  wilaya?: string;

  @Property({ nullable: true })
  commune?: string;

  @Property({ type: 'float', nullable: true })
  gpsLat?: number;

  @Property({ type: 'float', nullable: true })
  gpsLng?: number;

  /** Immatriculation du véhicule assuré par `company` (partie A de cette déclaration). */
  @Property({ nullable: true })
  plateA?: string;

  /** Immatriculation du véhicule adverse telle que déclarée (partie B). */
  @Property({ nullable: true })
  plateB?: string;

  /** N° attestation/police A — "police/attestation croisés" (B.5). */
  @Property({ nullable: true })
  policeA?: string;

  @Property({ nullable: true })
  policeB?: string;

  @Property({ type: 'smallint', nullable: true })
  nombreVehicules?: number;

  @Property({ nullable: true })
  territoire?: string;

  @Property({ nullable: true })
  dommagesCorporelsDeclares?: boolean;

  @Property({ nullable: true })
  adversePartieAdherente?: boolean;

  @Property({ nullable: true })
  adversePartieActive?: boolean;

  @Property({ type: 'float', nullable: true })
  estimatedAmount?: number;

  @Property({ type: 'float', nullable: true })
  expertAmount?: number;

  @Property({ type: 'text[]', nullable: true })
  exclusions?: string[];

  @Property({ type: 'text[]', nullable: true })
  piecesFournies?: string[];

  @Property({ nullable: true })
  constatAmiableSigneDeuxParties?: boolean;

  @Property({ type: 'date', nullable: true })
  dateDemandeRecours?: string;

  @Property({ nullable: true })
  canalDeclaration?: string;

  /** État du dossier — voir `CLAIM_STATES` (dto/claim.dto.ts). */
  @Property({ default: 'RECU' })
  state: string = 'RECU';

  @Property({ nullable: true })
  eligibilityVerdict?: string;

  @Property({ type: 'text[]', nullable: true })
  eligibilityReasons?: string[];

  /** Ligne source complète (47 colonnes, B.4) — audit et ré-évaluation. */
  @Property({ type: 'json' })
  raw!: Record<string, unknown>;

  /** Nom du fichier d'import d'origine. */
  @Property({ nullable: true })
  sourceFile?: string;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();

  // --- Barème Art. 14 (décision PO §5) : nullables, jamais remplis
  // rétroactivement. Saisie par import (colonnes 48-53) ou
  // `PATCH /claims/:id/responsabilite`.

  /** Cases cochées du constat pour le véhicule A (1-17). */
  @Property({ type: 'number[]', columnType: 'smallint[]', nullable: true })
  circonstancesA?: number[];

  @Property({ type: 'number[]', columnType: 'smallint[]', nullable: true })
  circonstancesB?: number[];

  /** Version `VALIDE_UAR` du barème dans laquelle `baremeCode` a été accepté. */
  @Property({ type: 'uuid', nullable: true })
  baremeVersionId?: string;

  @Property({ nullable: true, length: 32 })
  baremeCode?: string;

  @Property({ nullable: true, length: 32 })
  vehicleCategoryA?: string;

  @Property({ nullable: true, length: 32 })
  vehicleCategoryB?: string;

  /** Copie de la valeur déclarée (colonnes 32-33, en %) à l'import — jamais une déduction. */
  @Property({ type: 'float', nullable: true })
  responsabiliteDeclareeA?: number;

  @Property({ type: 'float', nullable: true })
  responsabiliteDeclareeB?: number;

  /**
   * SEC-12 — clés de rapprochement normalisées (`E:` e-constat, `P:` plaque,
   * `N:` police/attestation, voir `matchKeysFor`, matching.selection.ts),
   * index GIN : l'appariement charge les seules déclarations partageant une
   * clé (`&&`) au lieu de toute la table. Écrites à la création du dossier.
   */
  @Property({ type: 'text[]', nullable: true })
  matchKeys?: string[];
}
