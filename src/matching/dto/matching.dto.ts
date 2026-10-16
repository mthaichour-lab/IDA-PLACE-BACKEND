import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
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
}

export class MatchDecisionDto {
  @ApiProperty({ enum: MATCH_DECISIONS }) action!: 'confirm' | 'reject' | 'complement' | 'link';
  @ApiPropertyOptional() reason?: string;
  @ApiPropertyOptional({ description: 'Id de la déclaration à lier (action=link)' }) linkDeclId?: string;
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
