import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsEnum, IsHexColor, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateBy, ValidationOptions } from 'class-validator';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination.dto';
import { COMPANY_CODE_MESSAGE, COMPANY_CODE_PATTERN, MAX_PAGE_SIZE } from '../../recours/dto/recours.dto';
import { CompanyKind, CompanyStatus, FeedMode } from '../entities/company.entity';

/**
 * SEC-44 — délais dérogatoires : objet plat, 20 clés au plus (identifiant
 * alphanumérique), valeurs entières de 0 à 3650 jours. Auparavant `@IsObject`
 * seul : n'importe quelle structure était stockée en jsonb.
 */
export function IsDelayOverrides(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isDelayOverrides',
      validator: {
        validate: (value: unknown) => {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
          const entries = Object.entries(value as Record<string, unknown>);
          return (
            entries.length <= 20 &&
            entries.every(([k, v]) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) && typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3650)
          );
        },
        defaultMessage: () => 'delayOverrides : objet de 20 clés au plus (identifiants), valeurs entières de 0 à 3650 jours',
      },
    },
    options,
  );
}

/** Pagination du référentiel (SEC-44 : 100 lignes au plus). */
export class ReferentialPageQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) page: number = 1;
  @ApiPropertyOptional({ default: DEFAULT_PAGE_SIZE, minimum: 1, maximum: MAX_PAGE_SIZE }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE_SIZE) pageSize: number = DEFAULT_PAGE_SIZE;
}

export class CreateCompanyDto {
  /**
   * SEC-44 : 2 à 4 caractères majuscules/chiffres (colonne `varchar(4)`). Les
   * codes réels ne font pas tous 4 lettres (ex. SAA, GAM) : l'ancien
   * `@Length(4, 4)` refusait de recréer une compagnie existante comme SAA.
   */
  @ApiProperty({ minLength: 2, maxLength: 4, example: 'CAAT' })
  @IsString()
  @Matches(COMPANY_CODE_PATTERN, { message: COMPANY_CODE_MESSAGE })
  code!: string;

  @ApiProperty({ example: 'Compagnie Algérienne des Assurances' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
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

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'integer' }, description: 'Délais dérogatoires par compagnie (jsonb) — entiers en jours' })
  @IsOptional()
  @IsDelayOverrides()
  delayOverrides?: Record<string, number>;

  @ApiPropertyOptional({ description: 'Correspondant désigné par l’adhérent (écran 12) — optionnel, additif' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  correspondentName?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) correspondentPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(255) correspondentEmail?: string;
}

/**
 * SEC-04 — mise à jour du PROFIL d'une compagnie (coordonnées, contacts),
 * ouverte au correspondant sur SA compagnie. Les champs de GOUVERNANCE
 * (`status`, `delayOverrides`, `kind`, `feedMode`) restent déclarés
 * uniquement pour être REFUSÉS explicitement (403 `GOUVERNANCE_RESERVEE`)
 * plutôt qu'ignorés en silence : ils passent par
 * `POST /referential/companies/:id/governance-changes` (ADMIN_UAR, quatre yeux).
 */
export class UpdateCompanyDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(255) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) nameAr?: string;
  @ApiPropertyOptional() @IsOptional() @IsHexColor() color?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) correspondentName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) correspondentPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(255) correspondentEmail?: string;

  @ApiPropertyOptional({ enum: CompanyKind, deprecated: true, description: 'Refusé (403) : voir /governance-changes' }) @IsOptional() @IsEnum(CompanyKind) kind?: CompanyKind;
  @ApiPropertyOptional({ enum: FeedMode, deprecated: true, description: 'Refusé (403) : voir /governance-changes' }) @IsOptional() @IsEnum(FeedMode) feedMode?: FeedMode;
  @ApiPropertyOptional({ enum: CompanyStatus, deprecated: true, description: 'Refusé (403) : voir /governance-changes' }) @IsOptional() @IsEnum(CompanyStatus) status?: CompanyStatus;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, deprecated: true, description: 'Refusé (403) : voir /governance-changes' }) @IsOptional() delayOverrides?: Record<string, unknown>;
}

/** Champs de gouvernance d'une compagnie (SEC-04). */
export const GOVERNANCE_FIELDS = ['status', 'delayOverrides', 'kind', 'feedMode'] as const;

/** SEC-04 — demande de changement de gouvernance (ADMIN_UAR), appliquée après validation par un autre ADMIN_UAR. */
export class UpdateCompanyGovernanceDto {
  @ApiPropertyOptional({ enum: CompanyStatus }) @IsOptional() @IsEnum(CompanyStatus) status?: CompanyStatus;
  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'integer' } }) @IsOptional() @IsDelayOverrides() delayOverrides?: Record<string, number>;
  @ApiPropertyOptional({ enum: CompanyKind }) @IsOptional() @IsEnum(CompanyKind) kind?: CompanyKind;
  @ApiPropertyOptional({ enum: FeedMode }) @IsOptional() @IsEnum(FeedMode) feedMode?: FeedMode;

  @ApiProperty({ description: 'Motif du changement (décision de commission, courrier…)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

export class GovernanceChangeViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() companyCode!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) patch!: Record<string, unknown>;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: ['EN_ATTENTE', 'VALIDEE', 'REJETEE'] }) status!: string;
  @ApiProperty() requestedById!: string;
  @ApiProperty() requestedBy!: string;
  @ApiProperty() requestedAt!: string;
  @ApiPropertyOptional() decidedById?: string;
  @ApiPropertyOptional() decidedBy?: string;
  @ApiPropertyOptional() decidedAt?: string;
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

/**
 * SEC-26 — projection publique d'une compagnie CONCURRENTE pour un rôle
 * compagnie (minimisation, loi 18-07) : identité et statut seulement, sans
 * correspondant, contacts, délais dérogatoires, mode d'alimentation ni réseau.
 */
export class CompanyPublicViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() nameAr?: string;
  @ApiProperty() color!: string;
  @ApiProperty({ enum: CompanyKind }) kind!: CompanyKind;
  @ApiProperty({ enum: CompanyStatus }) status!: CompanyStatus;
}
