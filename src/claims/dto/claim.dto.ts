import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
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
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize: number = DEFAULT_PAGE_SIZE;
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
}
