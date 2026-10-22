import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../common/dto/pagination.dto';
import { PRIVILEGES, ROLES } from '../../common/rbac/roles-privileges';

/** SEC-44 — code compagnie (même espace que `Claim.company`, ex. `CAAT`, `SAA`) : 2 à 16 caractères majuscules/chiffres. */
const COMPANY_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,15}$/;
const COMPANY_CODE_MESSAGE = 'companyId doit être un code compagnie (2 à 16 caractères : majuscules, chiffres, _ ou -).';

/** Séparation des comptes : la place (opérateur, Admin FinLab/UAR, commission, audit) ou les compagnies (correspondants, trésoriers). */
export const USER_SCOPES = ['PLACE', 'COMPAGNIE'] as const;
export type UserScope = (typeof USER_SCOPES)[number];

export class ListPlaceUsersQueryDto {
  @ApiPropertyOptional({ enum: USER_SCOPES, description: 'PLACE : comptes de la place ; COMPAGNIE : comptes rattachés à une compagnie' })
  @IsOptional()
  @IsIn(USER_SCOPES as unknown as string[])
  scope?: UserScope;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE_SIZE) pageSize: number = DEFAULT_PAGE_SIZE;
}

export class CreatePlaceUserDto {
  @ApiProperty() @IsString() @MaxLength(255) name!: string;
  @ApiProperty() @IsEmail() @MaxLength(255) email!: string;
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES as unknown as string[]) role!: string;
  @ApiPropertyOptional({ example: 'CAAT' }) @IsOptional() @IsString() @Matches(COMPANY_CODE_PATTERN, { message: COMPANY_CODE_MESSAGE }) companyId?: string;
  @ApiPropertyOptional({ type: [String], enum: PRIVILEGES }) @IsOptional() @IsArray() @ArrayMaxSize(PRIVILEGES.length) @IsIn(PRIVILEGES as unknown as string[], { each: true }) grant?: string[];
  @ApiPropertyOptional({ type: [String], enum: PRIVILEGES }) @IsOptional() @IsArray() @ArrayMaxSize(PRIVILEGES.length) @IsIn(PRIVILEGES as unknown as string[], { each: true }) revoke?: string[];
}

export class UpdatePlaceUserDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(255) email?: string;
  @ApiPropertyOptional({ enum: ROLES }) @IsOptional() @IsIn(ROLES as unknown as string[]) role?: string;
  @ApiPropertyOptional({ example: 'CAAT' }) @IsOptional() @IsString() @Matches(COMPANY_CODE_PATTERN, { message: COMPANY_CODE_MESSAGE }) companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional({ type: [String], enum: PRIVILEGES }) @IsOptional() @IsArray() @ArrayMaxSize(PRIVILEGES.length) @IsIn(PRIVILEGES as unknown as string[], { each: true }) grant?: string[];
  @ApiPropertyOptional({ type: [String], enum: PRIVILEGES }) @IsOptional() @IsArray() @ArrayMaxSize(PRIVILEGES.length) @IsIn(PRIVILEGES as unknown as string[], { each: true }) revoke?: string[];
}

export class PlaceUserViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ROLES }) role!: string;
  @ApiPropertyOptional() companyId?: string;
  @ApiProperty() active!: boolean;
  @ApiProperty({ type: [String] }) grant!: string[];
  @ApiProperty({ type: [String] }) revoke!: string[];
}
