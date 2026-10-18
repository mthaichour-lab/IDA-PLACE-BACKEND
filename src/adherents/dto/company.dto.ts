import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsHexColor, IsObject, IsOptional, IsString, Length } from 'class-validator';
import { CompanyKind, CompanyStatus, FeedMode } from '../entities/company.entity';

export class CreateCompanyDto {
  @ApiProperty({ minLength: 4, maxLength: 4, example: 'CAAT' })
  @IsString()
  @Length(4, 4)
  code!: string;

  @ApiProperty({ example: 'Compagnie Algérienne des Assurances' })
  @IsString()
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nameAr?: string;

  @ApiProperty({ example: '#1F4FA3' })
  @IsHexColor()
  color!: string;

  @ApiProperty({ enum: CompanyKind, default: CompanyKind.INSURER })
  @IsEnum(CompanyKind)
  kind: CompanyKind = CompanyKind.INSURER;

  @ApiProperty({ enum: FeedMode, default: FeedMode.IMPORT })
  @IsEnum(FeedMode)
  feedMode: FeedMode = FeedMode.IMPORT;

  @ApiPropertyOptional({ enum: CompanyStatus, default: CompanyStatus.ACTIF })
  @IsOptional()
  @IsEnum(CompanyStatus)
  status?: CompanyStatus;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'Délais dérogatoires par compagnie (jsonb)' })
  @IsOptional()
  @IsObject()
  delayOverrides?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Correspondant désigné par l’adhérent (écran 12) — optionnel, additif' })
  @IsOptional()
  @IsString()
  correspondentName?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() correspondentPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() correspondentEmail?: string;
}

export class UpdateCompanyDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() nameAr?: string;
  @ApiPropertyOptional() @IsOptional() @IsHexColor() color?: string;
  @ApiPropertyOptional({ enum: CompanyKind }) @IsOptional() @IsEnum(CompanyKind) kind?: CompanyKind;
  @ApiPropertyOptional({ enum: FeedMode }) @IsOptional() @IsEnum(FeedMode) feedMode?: FeedMode;
  @ApiPropertyOptional({ enum: CompanyStatus }) @IsOptional() @IsEnum(CompanyStatus) status?: CompanyStatus;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) @IsOptional() @IsObject() delayOverrides?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsString() correspondentName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() correspondentPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() correspondentEmail?: string;
}

/** Vue publique d'une compagnie — la clé API n'est JAMAIS renvoyée en clair. */
export class CompanyViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() nameAr?: string;
  @ApiProperty() color!: string;
  @ApiProperty({ enum: CompanyKind }) kind!: CompanyKind;
  @ApiProperty({ enum: FeedMode }) feedMode!: FeedMode;
  @ApiProperty({ enum: CompanyStatus }) status!: CompanyStatus;
  @ApiProperty({ description: 'Clé API masquée, ex: "sk_live_•••••3f2a". Jamais en clair.' })
  apiKeyMasked!: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) delayOverrides?: Record<string, unknown>;
  /** Date d'adhésion (écran 12) — additif, réutilise `Company.createdAt`. */
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional() correspondentName?: string;
  @ApiPropertyOptional() correspondentPhone?: string;
  @ApiPropertyOptional() correspondentEmail?: string;
  /** Répartition réelle des agences par type (DG/DR/AG) — additif, écran 12 ("1 DG · 3 DR · 8 agences"). */
  @ApiProperty({ type: Object, example: { DG: 1, DR: 3, AG: 8 } }) agencyCounts!: Record<'DG' | 'DR' | 'AG', number>;
}
