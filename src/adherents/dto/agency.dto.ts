import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { AgencyType } from '../entities/agency.entity';
import { CompanyStatus } from '../entities/company.entity';
import { ReferentialPageQueryDto } from './company.dto';

const WILAYA_CODE = /^\d{2}$/;

export class CreateAgencyDto {
  @ApiProperty() @IsUUID() companyId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(32) @Matches(/^[A-Za-z0-9_-]+$/, { message: 'code agence : lettres, chiffres, _ et -' }) code!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(255) name!: string;
  @ApiProperty({ enum: AgencyType, default: AgencyType.AG }) @IsEnum(AgencyType) type: AgencyType = AgencyType.AG;
  /** SEC-31 : doit désigner une agence de la MÊME compagnie (400 sinon). */
  @ApiPropertyOptional({ description: 'Agence parente — de la même compagnie' }) @IsOptional() @IsUUID() parentId?: string;
  @ApiPropertyOptional({ description: 'Code wilaya (01-69)' }) @IsOptional() @Matches(WILAYA_CODE, { message: 'wilayaCode : code sur 2 chiffres' }) wilayaCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) manager?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(255) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) address?: string;
}

export class UpdateAgencyDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(255) name?: string;
  @ApiPropertyOptional({ enum: AgencyType }) @IsOptional() @IsEnum(AgencyType) type?: AgencyType;
  /** SEC-31 : rattachement hiérarchique — même compagnie, sans cycle (400 sinon). */
  @ApiPropertyOptional({ description: 'Agence parente — de la même compagnie, sans cycle' }) @IsOptional() @IsUUID() parentId?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(WILAYA_CODE, { message: 'wilayaCode : code sur 2 chiffres' }) wilayaCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) manager?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(255) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) address?: string;
  @ApiPropertyOptional({ enum: CompanyStatus }) @IsOptional() @IsEnum(CompanyStatus) status?: CompanyStatus;
}

/** SEC-44 : `companyId` typé (UUID) — `?companyId[$ne]=X` est refusé (400) au lieu d'atteindre le filtre ORM. */
export class ListAgenciesQueryDto extends ReferentialPageQueryDto {
  @ApiPropertyOptional({ description: 'Filtre par compagnie (id) — un rôle compagnie ne voit que SES agences' }) @IsOptional() @IsUUID() companyId?: string;
}

export class AgencyViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: AgencyType }) type!: AgencyType;
  @ApiPropertyOptional() parentId?: string;
  @ApiPropertyOptional() wilayaCode?: string;
  @ApiPropertyOptional() manager?: string;
  @ApiPropertyOptional() phone?: string;
  @ApiPropertyOptional() email?: string;
  @ApiPropertyOptional() address?: string;
  @ApiProperty({ enum: CompanyStatus }) status!: CompanyStatus;
}
