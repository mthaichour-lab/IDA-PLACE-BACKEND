import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination.dto';

export const MATCH_LEVELS = ['AUTO', 'MANUEL', 'NON'] as const;
export const MATCH_STATUSES = ['A_CONFIRMER', 'AUTO_CONFIRME', 'CONFIRME_MANUEL', 'REJETE', 'COMPLEMENT'] as const;
export const MATCH_FILTERS = ['TOUS', 'AUTO', 'A_CONFIRMER', 'NON_APPARIES'] as const;
export const MATCH_DECISIONS = ['confirm', 'reject', 'complement', 'link'] as const;

/** Critères pondérés du score d'appariement — B.5. */
export class MatchCriteriaDto {
  @ApiProperty() econstatPartage!: boolean; // clé exacte
  @ApiProperty() plaquesCroisees!: boolean; // poids 35
  @ApiProperty() policeCroisee!: boolean; // poids 15
  @ApiProperty() dateHeure!: boolean; // poids 15
  @ApiProperty() compagniesCroisees!: boolean; // poids 10
  @ApiProperty() gps!: boolean; // poids 10
}

export class MatchQueueQueryDto {
  @ApiPropertyOptional({ enum: MATCH_FILTERS, default: 'TOUS' }) @IsOptional() @IsIn(MATCH_FILTERS as unknown as string[]) filter: string = 'TOUS';
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize: number = DEFAULT_PAGE_SIZE;
}

export class TauxSelonBaremeDto {
  @ApiProperty() baremeVersionId!: string;
  @ApiProperty() versionLabel!: string;
  @ApiProperty() partA!: number;
  @ApiProperty() partB!: number;
}

/** Saisie Art. 14 d'une déclaration (A = son assuré, B = la partie adverse). */
export class DeclarationResponsabiliteDto {
  @ApiPropertyOptional({ type: [Number] }) circonstancesA?: number[];
  @ApiPropertyOptional({ type: [Number] }) circonstancesB?: number[];
  @ApiPropertyOptional() baremeVersionId?: string;
  @ApiPropertyOptional() baremeCode?: string;
  @ApiPropertyOptional() vehicleCategoryA?: string;
  @ApiPropertyOptional() vehicleCategoryB?: string;
  @ApiPropertyOptional({ description: 'Taux déclaré A (%)' }) responsabiliteDeclareeA?: number;
  @ApiPropertyOptional({ description: 'Taux déclaré B (%)' }) responsabiliteDeclareeB?: number;
  @ApiPropertyOptional({ type: TauxSelonBaremeDto, description: 'Présent seulement si une version VALIDE_UAR couvre le code' }) tauxSelonBareme?: TauxSelonBaremeDto;
}

/** Ligne de la file de confrontation — écran 2. */
export class MatchQueueItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() refA!: string;
  @ApiProperty() companyA!: string;
  @ApiProperty() plateA!: string;
  @ApiPropertyOptional() refB?: string;
  @ApiPropertyOptional() companyB?: string;
  @ApiPropertyOptional() plateB?: string;
  @ApiProperty() score!: number;
  @ApiProperty({ enum: MATCH_LEVELS }) level!: string;
  @ApiProperty({ enum: MATCH_STATUSES }) status!: string;
  @ApiProperty() econstatShared!: boolean;
  @ApiProperty({ type: MatchCriteriaDto }) criteria!: MatchCriteriaDto;
  @ApiPropertyOptional() confirmedBy?: string;
  @ApiPropertyOptional() confirmedAt?: string;
  @ApiPropertyOptional() rejectReason?: string;
  @ApiProperty() at!: string;

  // --- Champs optionnels additifs (2026-10-18, écran 2 "Vue de
  // confrontation") — une valeur par déclaration (A = `declAId`, B =
  // `declBId`, quand apparié), dénormalisés depuis `ClaimMatchInput` au
  // même recalcul que `criteria` (voir `matching.service.ts` `applyComputed`).
  // Affichage uniquement : ne changent ni le score ni le niveau
  // AUTO/MANUEL/NON (contrat stable, forme existante ci-dessus inchangée).
  @ApiPropertyOptional() accidentDateA?: string;
  @ApiPropertyOptional() accidentDateB?: string;
  @ApiPropertyOptional() wilayaA?: string;
  @ApiPropertyOptional() wilayaB?: string;
  /** N° police/attestation PROPRE à chaque déclaration (même convention que `plateA`/`plateB` ci-dessus : valeur "soi-même", pas la partie adverse déclarée). */
  @ApiPropertyOptional() policeA?: string;
  @ApiPropertyOptional() policeB?: string;
  @ApiPropertyOptional() assureAIdentite?: string;
  @ApiPropertyOptional() assureBIdentite?: string;
  @ApiPropertyOptional({ enum: ['ERP', 'ECONSTAT', 'IMPORT', 'API'] }) canalDeclarationA?: string;
  @ApiPropertyOptional({ enum: ['ERP', 'ECONSTAT', 'IMPORT', 'API'] }) canalDeclarationB?: string;

  // --- Barème Art. 14 (décision PO §5), additif : une saisie par déclaration.
  @ApiPropertyOptional({ type: DeclarationResponsabiliteDto }) responsabiliteA?: DeclarationResponsabiliteDto;
  @ApiPropertyOptional({ type: DeclarationResponsabiliteDto }) responsabiliteB?: DeclarationResponsabiliteDto;
  @ApiProperty({ description: 'Vrai si A et B ont chacune un code de barème et que ces codes diffèrent' }) divergence!: boolean;
}

/** `GET /matching/:id` : la ligne de file + les id des dossiers, cible de `PATCH /claims/:id/responsabilite`. */
export class MatchItemDetailDto extends MatchQueueItemDto {
  @ApiProperty({ description: 'Id du dossier de la déclaration A' }) claimAId!: string;
  @ApiPropertyOptional({ description: 'Id du dossier de la contrepartie B, absent tant que rien n’est apparié' }) claimBId?: string;
}

export class MatchDecisionDto {
  @ApiProperty({ enum: MATCH_DECISIONS })
  @IsIn(MATCH_DECISIONS as unknown as string[])
  action!: 'confirm' | 'reject' | 'complement' | 'link';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({ description: 'Id de la déclaration à lier (action=link)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  linkDeclId?: string;
}

export class MatchDecisionResultDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: MATCH_STATUSES }) status!: string;
  @ApiProperty() decidedAt!: string;
  @ApiProperty() decidedBy!: string;
}

export class MatchThresholdsDto {
  @ApiProperty({ default: 80 }) autoThreshold!: number;
  @ApiProperty({ default: 50 }) confirmThreshold!: number;
}
