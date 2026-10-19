import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import {
  IRSAM_INDICATORS,
  IrsamIndicator,
  MOBILE_HOLIDAY_KINDS,
  MobileHolidayKind,
  POPULATION_SOURCE_TYPES,
  PopulationSourceType,
} from '../place-referential.data';
import { ISO_DATE_PATTERN } from '../referential-rules';

const ISO_DATE_MESSAGE = 'date ISO attendue (AAAA-MM-JJ)';

// ---- Calendrier / fériés mobiles (§2) ----------------------------------

export class CalendarQueryDto {
  @ApiPropertyOptional({ example: '2026-01-01' }) @IsOptional() @Matches(ISO_DATE_PATTERN, { message: ISO_DATE_MESSAGE }) from?: string;
  @ApiPropertyOptional({ example: '2026-12-31' }) @IsOptional() @Matches(ISO_DATE_PATTERN, { message: ISO_DATE_MESSAGE }) to?: string;
}

export class ListMobileHolidaysQueryDto {
  @ApiPropertyOptional({ example: 2026 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1900) @Max(2200) year?: number;
}

export class CreateMobileHolidayDto {
  @ApiProperty({ example: '2026-03-20' }) @Matches(ISO_DATE_PATTERN, { message: ISO_DATE_MESSAGE }) date!: string;
  @ApiProperty({ enum: MOBILE_HOLIDAY_KINDS }) @IsIn(MOBILE_HOLIDAY_KINDS as unknown as string[]) kind!: MobileHolidayKind;
  @ApiPropertyOptional({ example: 1447 }) @IsOptional() @IsInt() @Min(1300) @Max(1700) hijriYear?: number;
}

export class UpdateMobileHolidayDto {
  @ApiPropertyOptional() @IsOptional() @Matches(ISO_DATE_PATTERN, { message: ISO_DATE_MESSAGE }) date?: string;
  @ApiPropertyOptional({ enum: MOBILE_HOLIDAY_KINDS }) @IsOptional() @IsIn(MOBILE_HOLIDAY_KINDS as unknown as string[]) kind?: MobileHolidayKind;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1300) @Max(1700) hijriYear?: number;
}

export class ConfirmMobileHolidayDto {
  @ApiProperty({ description: 'Référence du communiqué ou du décret' }) @IsString() @IsNotEmpty() @MaxLength(255) sourceRef!: string;
  @ApiPropertyOptional({ description: 'Date confirmée, si elle diffère de la date prévisionnelle' })
  @IsOptional()
  @Matches(ISO_DATE_PATTERN, { message: ISO_DATE_MESSAGE })
  date?: string;
}

// ---- Circonstances du constat / motifs d'opposition (§1) ---------------

export class UpdateConstatCircumstanceDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(255) labelFr?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) labelAr?: string;
}

export class CreateOppositionMotifDto {
  @ApiProperty({ example: 'MONTANT_CONTESTE' }) @Matches(/^[A-Z0-9_]{2,64}$/, { message: 'code : majuscules, chiffres et _ (2 à 64)' }) code!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(255) label!: string;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() forbidden?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) sourceRef?: string;
}

export class UpdateOppositionMotifDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(255) label?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() forbidden?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) sourceRef?: string;
}

// ---- Wilayas / populations (§3) ----------------------------------------

export class UpdateWilayaPerimeterDto {
  @ApiPropertyOptional({ nullable: true, example: '2019-12-18' })
  @IsOptional()
  @Matches(ISO_DATE_PATTERN, { message: ISO_DATE_MESSAGE })
  effectiveFrom?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '01' })
  @IsOptional()
  @Matches(/^\d{2}$/, { message: 'parentCode : code wilaya sur 2 chiffres' })
  parentCode?: string | null;
}

export class ListWilayaPopulationsQueryDto {
  @ApiPropertyOptional({ example: '16' }) @IsOptional() @Matches(/^\d{2}$/) wilayaCode?: string;
}

export class CreateWilayaPopulationDto {
  @ApiProperty({ example: '16' }) @Matches(/^\d{2}$/, { message: 'wilayaCode : code sur 2 chiffres' }) wilayaCode!: string;
  @ApiProperty({ example: 2024 }) @IsInt() @Min(1900) @Max(2200) referenceYear!: number;
  @ApiProperty() @IsInt() @Min(1) population!: number;
  @ApiProperty({ enum: POPULATION_SOURCE_TYPES }) @IsIn(POPULATION_SOURCE_TYPES as unknown as string[]) sourceType!: PopulationSourceType;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(255) sourceRef!: string;
}

export class UpdateWilayaPopulationDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) population?: number;
  @ApiPropertyOptional({ enum: POPULATION_SOURCE_TYPES }) @IsOptional() @IsIn(POPULATION_SOURCE_TYPES as unknown as string[]) sourceType?: PopulationSourceType;
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(255) sourceRef?: string;
}

// ---- Référence IRSAM (§4) ----------------------------------------------

export class IrsamMeasureDefinitionDto {
  @ApiProperty({ example: 'Envoi de la demande de recours' }) @IsString() @IsNotEmpty() startEvent!: string;
  @ApiProperty({ example: 'Règlement inter-compagnies' }) @IsString() @IsNotEmpty() endEvent!: string;
  @ApiProperty({ example: 'Recours matériels réglés sur E-Recours' }) @IsString() @IsNotEmpty() scope!: string;
}

export class CreateIrsamBenchmarkDto {
  @ApiProperty({ enum: IRSAM_INDICATORS }) @IsIn(IRSAM_INDICATORS as unknown as string[]) indicator!: IrsamIndicator;
  @ApiProperty() @IsNumber() @Min(0) value!: number;
  @ApiProperty({ example: '2025-01-01' }) @Matches(ISO_DATE_PATTERN, { message: ISO_DATE_MESSAGE }) periodFrom!: string;
  @ApiProperty({ example: '2025-12-31' }) @Matches(ISO_DATE_PATTERN, { message: ISO_DATE_MESSAGE }) periodTo!: string;
  @ApiProperty({ type: IrsamMeasureDefinitionDto }) @IsObject() @ValidateNested() @Type(() => IrsamMeasureDefinitionDto) measureDefinition!: IrsamMeasureDefinitionDto;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(255) sourceRef!: string;
}
