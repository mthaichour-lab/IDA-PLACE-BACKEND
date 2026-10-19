import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { COMPANY_CODE_PATTERN } from '../../claims/dto/claim-import.dto';

/** Métriques de la grille TARIF-2026.01 (§B.8) — liste blanche (SEC-37 : plus de clé arbitraire, ex. `__proto__`). */
export const KNOWN_METRICS = ['apiCalls', 'claimsIngested', 'matchings', 'storageGB', 'bandwidthGB', 'ocrPages', 'sms', 'emails', 'activeUsers', 'cpuHours', 'memGBh', 'backupsGB'] as const;

export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_PRICE = 1_000_000_000;

export class PriceGridMetricPatchDto {
  @ApiProperty({ enum: KNOWN_METRICS }) @IsIn(KNOWN_METRICS as unknown as string[]) metric!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) label?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) unit?: string;
  @ApiPropertyOptional({ minimum: 0 }) @IsOptional() @IsInt() @Min(0) @Max(MAX_PRICE) includedQuota?: number;
  @ApiPropertyOptional({ minimum: 0 }) @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_PRICE) unitPrice?: number;
}

export class PriceGridSubscriptionPatchDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) label?: string;
  @ApiPropertyOptional({ minimum: 0 }) @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_PRICE) monthly?: number;
}

/**
 * SEC-37 — `PUT /pricing/grid` : crée une NOUVELLE version (jamais une
 * modification rétroactive) à partir de la version en vigueur à sa date
 * d'effet, inducteurs fusionnés par clé.
 */
export class UpdatePriceGridDto {
  @ApiProperty({ example: 'TARIF-2027.01' }) @Matches(/^TARIF-\d{4}\.\d{2}$/, { message: 'version : format TARIF-AAAA.NN attendu.' }) version!: string;
  @ApiProperty({ example: '2027-01-01', description: 'Date d’effet (AAAA-MM-JJ), au plus tôt aujourd’hui' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, { message: 'effectiveFrom : date AAAA-MM-JJ attendue.' })
  effectiveFrom!: string;
  @ApiPropertyOptional({ type: PriceGridSubscriptionPatchDto }) @IsOptional() @ValidateNested() @Type(() => PriceGridSubscriptionPatchDto) subscription?: PriceGridSubscriptionPatchDto;
  @ApiPropertyOptional({ type: [PriceGridMetricPatchDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(KNOWN_METRICS.length)
  @ValidateNested({ each: true })
  @Type(() => PriceGridMetricPatchDto)
  metrics?: PriceGridMetricPatchDto[];
}

/** SEC-37/SEC-44 — paramètres de route typés (code compagnie, période AAAA-MM, métrique connue). */
export class MeteringPeriodParamDto {
  @Matches(PERIOD_PATTERN, { message: 'period : AAAA-MM attendu.' }) period!: string;
}

export class MeteringInvoiceParamsDto extends MeteringPeriodParamDto {
  @Matches(COMPANY_CODE_PATTERN, { message: 'company : code compagnie attendu.' }) company!: string;
}

export class MeteringHistoryParamsDto extends MeteringInvoiceParamsDto {
  @IsIn(KNOWN_METRICS as unknown as string[]) metric!: string;
}
