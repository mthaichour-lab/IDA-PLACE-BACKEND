import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { COMPANY_CODE_MESSAGE, COMPANY_CODE_PATTERN } from '../../recours/dto/recours.dto';
import { ExpertStatus } from '../entities/expert.entity';

const WILAYA_CODE = /^\d{2}$/;
/** RIB/IBAN : 10 à 34 caractères (chiffres, majuscules, espaces). */
const RIB_PATTERN = /^[0-9A-Z ]{10,34}$/;

/** SEC-44 : tableaux bornés et validés élément par élément (`each: true`). */
export class CreateExpertDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(255) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) firm?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) agrement?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(69) @Matches(WILAYA_CODE, { each: true, message: 'wilayas : codes sur 2 chiffres' }) wilayas?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(64, { each: true }) specialties?: string[];
  @ApiPropertyOptional({ type: [String], description: 'Compagnies servies — un rôle compagnie ne peut indiquer que la sienne' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @Matches(COMPANY_CODE_PATTERN, { each: true, message: COMPANY_CODE_MESSAGE })
  companies?: string[];
  @ApiPropertyOptional({ description: 'RIB (chiffré au repos, jamais renvoyé)' }) @IsOptional() @Matches(RIB_PATTERN, { message: 'rib : 10 à 34 caractères (chiffres, majuscules, espaces)' }) rib?: string;
}

export class UpdateExpertDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(255) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) firm?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) agrement?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(69) @Matches(WILAYA_CODE, { each: true, message: 'wilayas : codes sur 2 chiffres' }) wilayas?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(64, { each: true }) specialties?: string[];
  @ApiPropertyOptional({ type: [String], description: 'SEC-14 : un rôle compagnie ne peut ajouter ou retirer que son propre code' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @Matches(COMPANY_CODE_PATTERN, { each: true, message: COMPANY_CODE_MESSAGE })
  companies?: string[];
  @ApiPropertyOptional({ enum: ExpertStatus, description: 'SEC-14 : statut global, réservé aux rôles place' }) @IsOptional() @IsEnum(ExpertStatus) status?: ExpertStatus;
  @ApiPropertyOptional({ description: 'RIB (chiffré au repos, jamais renvoyé)' }) @IsOptional() @Matches(RIB_PATTERN, { message: 'rib : 10 à 34 caractères (chiffres, majuscules, espaces)' }) rib?: string;
}

export class ExpertViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() firm?: string;
  @ApiPropertyOptional() agrement?: string;
  @ApiProperty({ type: [String] }) wilayas!: string[];
  @ApiProperty({ type: [String] }) specialties!: string[];
  @ApiProperty({ type: [String], description: 'SEC-26 : pour un rôle compagnie, seulement sa propre compagnie' }) companies!: string[];
  @ApiProperty({ enum: ExpertStatus }) status!: ExpertStatus;
  @ApiPropertyOptional({ description: 'RIB masqué (4 derniers caractères) — rôles place uniquement' }) ribMasked?: string;
}
