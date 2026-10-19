import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/** Code compagnie (référentiel) : majuscules/chiffres, borné à la colonne `claim.company` (4). */
export const COMPANY_CODE_PATTERN = /^[A-Z0-9]{2,4}$/;

/**
 * SEC-02 — `POST /claims/import?company=XXXX`. Rôle compagnie : facultatif,
 * et s'il est fourni il doit être SA compagnie (403 sinon). Rôle place :
 * OBLIGATOIRE (400 sinon) — l'opérateur importe au nom d'une compagnie
 * désignée explicitement, jamais au nom de la colonne du fichier.
 */
export class ImportClaimsQueryDto {
  @ApiPropertyOptional({ description: 'Compagnie déclarante (code). Obligatoire pour un rôle place ; pour un rôle compagnie, égale à sa compagnie si fournie.' })
  @IsOptional()
  @Matches(COMPANY_CODE_PATTERN, { message: 'company : code compagnie attendu (2 à 4 majuscules/chiffres).' })
  company?: string;
}

export class ClaimImportRowResultDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty({ enum: ['ELIGIBLE_IDA', 'HORS_IDA'] }) verdict!: 'ELIGIBLE_IDA' | 'HORS_IDA';
  @ApiProperty({ type: [String], description: "Motifs (si HORS_IDA) — articles B.6 cités" })
  reasons!: string[];
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Valeurs des 47 colonnes pour cette ligne' })
  data!: Record<string, unknown>;
  /** Additif (SEC-02) : ligne refusée (compagnie A différente de la compagnie déclarante) — aucun dossier créé, verdict HORS_IDA. */
  @ApiPropertyOptional({ description: 'Vrai si la ligne a été refusée sans création de dossier (SEC-02)' }) rejected?: boolean;
}

/** Valeur d'une colonne d'extension 48-53 ignorée à l'import (décision PO §5). */
export class ClaimImportWarningDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty({ description: 'N° de colonne dans le fichier (48 à 53)' }) column!: number;
  @ApiProperty() columnKey!: string;
  @ApiProperty({ enum: ['BAREME_NON_PUBLIE', 'CIRCONSTANCE_INVALIDE', 'FORMULE_NEUTRALISEE'] }) code!: 'BAREME_NON_PUBLIE' | 'CIRCONSTANCE_INVALIDE' | 'FORMULE_NEUTRALISEE';
  @ApiProperty() message!: string;
}

/** Réponse de `POST /claims/import` — forme STABLE (B.4, B.11). */
export class ClaimImportReportDto {
  @ApiProperty() fileName!: string;
  @ApiProperty() importedAt!: string;
  @ApiProperty() totalRows!: number;
  @ApiProperty() eligibleCount!: number;
  @ApiProperty() ineligibleCount!: number;
  /** Additif (SEC-02) : lignes refusées sans création de dossier (comptées aussi dans `ineligibleCount`). */
  @ApiProperty() rejectedCount!: number;
  /** Additif (SEC-02) : compagnie au nom de laquelle les dossiers ont été créés. */
  @ApiProperty() company!: string;
  @ApiProperty({ type: [ClaimImportRowResultDto] }) rows!: ClaimImportRowResultDto[];
  /** Additif (décision PO §5) : avertissements des colonnes 48-53, vide pour un fichier à 47 colonnes. */
  @ApiProperty({ type: [ClaimImportWarningDto] }) warnings!: ClaimImportWarningDto[];
}

export class ClaimColumnDefDto {
  @ApiProperty() index!: number;
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: ['IDENTIFICATION', 'ELIGIBILITE'] }) group!: string;
  @ApiProperty() type!: string;
  @ApiProperty({ required: false, type: [String] }) enumValues?: string[];
}
