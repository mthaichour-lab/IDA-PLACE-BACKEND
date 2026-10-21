import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination.dto';
import { COMPANY_CODE_MESSAGE, COMPANY_CODE_PATTERN, MAX_PAGE_SIZE } from '../../recours/dto/recours.dto';
import { MAX_TECHNICAL_AMOUNT_DA } from '../../recours/money';
import { COMMISSION_CASE_STATUSES, SANCTION_STATUSES, SANCTION_TYPES } from '../commission.rules';

export class ListCommissionCasesQueryDto {
  @ApiPropertyOptional({ enum: COMMISSION_CASE_STATUSES }) @IsOptional() @IsIn(COMMISSION_CASE_STATUSES as unknown as string[]) status?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) page: number = 1;
  @ApiPropertyOptional({ maximum: MAX_PAGE_SIZE }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE_SIZE) pageSize: number = DEFAULT_PAGE_SIZE;
}

export class CreateCommissionCaseDto {
  @ApiProperty({ description: 'Id du recours transmis en commission (RecoursModule)' })
  @IsUUID()
  recoursId!: string;

  @ApiProperty({ description: 'Motif de la saisine de la commission' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  motif!: string;

  @ApiPropertyOptional({ description: 'Date de séance programmée (défaut : +14 jours ; jamais dans le passé)' })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;
}

export class CommissionDecisionDto {
  @ApiProperty() outcome!: string;
  @ApiPropertyOptional() motif?: string;
}

export class CommissionPvDto {
  @ApiProperty() signedBy!: string;
  @ApiProperty() signedAt!: string;
  @ApiProperty() ref!: string;
}

export class CommissionCaseViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Référence métier lisible et immuable (CSC-AAAA-NNN)', example: 'CSC-2026-011' }) reference!: string;
  @ApiProperty() recoursId!: string;
  @ApiPropertyOptional({ description: 'Référence métier du recours (REC-AAAA-NNNNN)' }) recoursReference?: string;
  @ApiProperty() claimId!: string;
  @ApiProperty() companyA!: string;
  @ApiProperty() companyB!: string;
  @ApiProperty() amount!: number;
  @ApiProperty() motif!: string;
  @ApiProperty({ enum: COMMISSION_CASE_STATUSES }) status!: string;
  @ApiProperty() scheduledAt!: string;
  @ApiPropertyOptional() decidedAt?: string;
  @ApiPropertyOptional({ type: CommissionDecisionDto }) decision?: CommissionDecisionDto;
  @ApiPropertyOptional({ type: CommissionPvDto }) pv?: CommissionPvDto;
  @ApiProperty() createdAt!: string;
}

export class DecideCommissionDto {
  @ApiProperty({ enum: ['RECOURS_FONDE', 'RECOURS_REJETE'] })
  @IsIn(['RECOURS_FONDE', 'RECOURS_REJETE'])
  outcome!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  motif?: string;
}

export class PenaltyDto {
  @ApiProperty({ description: 'Compagnie sanctionnée (doit être partie au recours)' })
  @IsString()
  @Matches(COMPANY_CODE_PATTERN, { message: COMPANY_CODE_MESSAGE })
  companyCode!: string;

  @ApiProperty({ description: 'Montant en DA (2 décimales au plus, ≤ plafond COMMISSION_PENALTY_MAX_DA)' })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_TECHNICAL_AMOUNT_DA)
  amount!: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  reason!: string;
}

export class SanctionOrderDto {
  @ApiProperty({ description: 'Compagnie sanctionnée (doit être partie au recours)' })
  @IsString()
  @Matches(COMPANY_CODE_PATTERN, { message: COMPANY_CODE_MESSAGE })
  companyCode!: string;

  @ApiProperty({ enum: ['AVERTISSEMENT', 'SUSPENSION'] })
  @IsIn(['AVERTISSEMENT', 'SUSPENSION'])
  type!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  reason!: string;
}

/**
 * SEC-32 : la référence du PV est générée par le serveur (`PV-<id dossier>`) ;
 * une `ref` fournie par le client n'est plus prise en compte.
 */
export class PvSignDto {}

export class SanctionViewDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() commissionCaseId?: string;
  @ApiProperty() companyCode!: string;
  @ApiProperty({ enum: SANCTION_TYPES }) type!: string;
  @ApiPropertyOptional() amount?: number;
  @ApiProperty() reason!: string;
  @ApiProperty() orderedAt!: string;
  @ApiProperty() orderedBy!: string;
  @ApiProperty({ enum: SANCTION_STATUSES, description: 'SEC-32 : A_CONTRESIGNER tant qu’un second membre n’a pas contresigné' }) status!: string;
  @ApiPropertyOptional() countersignedBy?: string;
  @ApiPropertyOptional() countersignedAt?: string;
}

export class ListSanctionsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(COMPANY_CODE_PATTERN, { message: COMPANY_CODE_MESSAGE }) company?: string;
  @ApiPropertyOptional({ enum: SANCTION_STATUSES }) @IsOptional() @IsIn(SANCTION_STATUSES as unknown as string[]) status?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) page: number = 1;
  @ApiPropertyOptional({ maximum: MAX_PAGE_SIZE }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE_SIZE) pageSize: number = DEFAULT_PAGE_SIZE;
}

/**
 * KPI de synthèse (écran 7, guide illustré) — endpoint additif
 * (`GET /commission/summary`), `CommissionCaseViewDto` ne change pas de
 * forme (contrat figé, voir ARCHITECTURE.md §1).
 */
export class CommissionSummaryDto {
  @ApiProperty({ description: 'Dossiers non encore tranchés (status A_INSTRUIRE ou EN_DELIBERE)' }) pendingCount!: number;
  @ApiProperty({ description: 'Parmi les dossiers pendants, ceux ouverts depuis plus de 15 jours (Art. 24)' }) overdue15dCount!: number;
  @ApiProperty({ description: 'Dossiers PRONONCE avec décision RECOURS_FONDE' }) recoursFondesCount!: number;
  @ApiProperty({ description: "Oppositions réputées fondées à défaut de contestation (Art. 12, RecoursModule — indépendant des dossiers de commission)" }) oppositionsFondeesCount!: number;
}
