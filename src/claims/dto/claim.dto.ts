import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination.dto';

export const CLAIM_STATES = [
  'RECU',
  'A_APPARIER',
  'APPARIE',
  'ELIGIBLE',
  'HORS_IDA',
  'EN_RECOURS',
  'REGLE',
  'FORCLOS',
] as const;

export class ListClaimsQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  // SEC-13 : borné à 100 (`?pageSize=100000` refusé, 400).
  @ApiPropertyOptional({ maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize: number = DEFAULT_PAGE_SIZE;
  @ApiPropertyOptional() @IsOptional() @IsString() company?: string;
  @ApiPropertyOptional({ enum: CLAIM_STATES }) @IsOptional() @IsIn(CLAIM_STATES as unknown as string[]) state?: string;
}

/** Vue dossier (Claim/Declaration) — B.3 "Claim / Declaration", écrans 2/3. */
export class ClaimViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() numEconstat!: string;
  @ApiProperty() company!: string;
  @ApiProperty() counterpartyCompany!: string;
  @ApiProperty() accidentDate!: string;
  @ApiProperty() wilaya!: string;
  @ApiProperty() estimatedAmount!: number;
  @ApiPropertyOptional() expertAmount?: number;
  @ApiProperty({ enum: CLAIM_STATES }) state!: string;
  @ApiProperty() createdAt!: string;

  // --- Champs optionnels additionnels (B.3/B.5) — ajoutés sans modifier les
  // champs existants ci-dessus (règle du contrat stable, voir HANDOFF.md).
  // Utilisés par MatchingModule (clé d'appariement + score, B.5) et par les
  // écrans qui affichent le détail d'une déclaration.
  @ApiPropertyOptional() commune?: string;
  @ApiPropertyOptional() accidentTime?: string;
  @ApiPropertyOptional() plateA?: string;
  @ApiPropertyOptional() plateB?: string;
  @ApiPropertyOptional() policeA?: string;
  @ApiPropertyOptional() policeB?: string;
  @ApiPropertyOptional() gpsLat?: number;
  @ApiPropertyOptional() gpsLng?: number;
  @ApiPropertyOptional({ enum: ['ELIGIBLE_IDA', 'HORS_IDA'] }) eligibilityVerdict?: string;
  @ApiPropertyOptional({ type: [String] }) eligibilityReasons?: string[];
  // --- Champ optionnel additionnel (sprint 3, Monitoring/Stats réels) ---
  // Nécessaire pour calculer réellement les "demandes tardives" (Monitoring,
  // B.2 écran 8) à partir de la vraie date de demande de recours (Art. 19),
  // sans dépendre de RecoursModule (toujours un mock). Ajout d'un champ
  // optionnel supplémentaire, aucun champ existant renommé/retiré — même
  // règle que les ajouts du sprint 2 ci-dessus (voir HANDOFF.md).
  @ApiPropertyOptional() dateDemandeRecours?: string;
  // --- Champ optionnel additionnel (sprint 3, StatsModule réel) : canal de
  // déclaration réel (B.4 colonne 47 — ERP/ECONSTAT/IMPORT/API), nécessaire
  // pour agréger réellement l'adoption e-constat sans inventer de valeur.
  @ApiPropertyOptional({ enum: ['ERP', 'ECONSTAT', 'IMPORT', 'API'] }) canalDeclaration?: string;
  // --- Champ optionnel additionnel (2026-10-18, écran 2 "Vue de
  // confrontation") : identité de l'assuré (colonne 44 du modèle 47
  // colonnes — B.4), lue depuis `Claim.raw` (jamais promue en colonne
  // typée, aucune migration nécessaire) — affichage uniquement
  // (MatchingModule, cartes "Véhicule A/B"), n'entre dans aucun calcul.
  @ApiPropertyOptional() assureIdentite?: string;
  // --- Barème Art. 14 (décision PO §5) : absents tant que non renseignés.
  @ApiPropertyOptional({ type: [Number] }) circonstancesA?: number[];
  @ApiPropertyOptional({ type: [Number] }) circonstancesB?: number[];
  @ApiPropertyOptional() baremeVersionId?: string;
  @ApiPropertyOptional() baremeCode?: string;
  @ApiPropertyOptional() vehicleCategoryA?: string;
  @ApiPropertyOptional() vehicleCategoryB?: string;
  @ApiPropertyOptional({ description: 'Responsabilité déclarée A (%), colonne 32 du fichier importé' }) responsabiliteDeclareeA?: number;
  @ApiPropertyOptional({ description: 'Responsabilité déclarée B (%), colonne 33 du fichier importé' }) responsabiliteDeclareeB?: number;
}

/**
 * `PATCH /claims/:id/responsabilite` — champ absent : inchangé ; `null` :
 * effacé. La responsabilité déclarée (colonnes 32-33) ne vient que de l'import.
 */
export class UpdateClaimResponsabiliteDto {
  @ApiPropertyOptional({ type: [Number], nullable: true, description: 'Cases 1 à 17 du constat, véhicule A' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(17)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(17, { each: true })
  circonstancesA?: number[] | null;

  @ApiPropertyOptional({ type: [Number], nullable: true, description: 'Cases 1 à 17 du constat, véhicule B' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(17)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(17, { each: true })
  circonstancesB?: number[] | null;

  @ApiPropertyOptional({ nullable: true, description: 'Code présent dans une version VALIDE_UAR du barème (sinon 400)' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  baremeCode?: string | null;

  @ApiPropertyOptional({ description: 'Version VALIDE_UAR visée (id) ; par défaut, la plus récemment validée qui contient le code' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  baremeVersionId?: string;

  @ApiPropertyOptional({ nullable: true, description: 'Catégorie VALIDE_UAR (sinon 400)' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  vehicleCategoryA?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Catégorie VALIDE_UAR (sinon 400)' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  vehicleCategoryB?: string | null;
}
