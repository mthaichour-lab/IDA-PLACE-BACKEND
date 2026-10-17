import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination.dto';
import { COMMISSION_CASE_STATUSES, SANCTION_TYPES } from '../commission.rules';

export class ListCommissionCasesQueryDto {
  @ApiPropertyOptional({ enum: COMMISSION_CASE_STATUSES }) @IsOptional() @IsIn(COMMISSION_CASE_STATUSES as unknown as string[]) status?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize: number = DEFAULT_PAGE_SIZE;
}

export class CreateCommissionCaseDto {
  @ApiProperty({ description: 'Id du recours transmis en commission (RecoursModule)' })
  @IsString()
  @IsNotEmpty()
  recoursId!: string;

  @ApiProperty({ description: 'Motif de la saisine de la commission' })
  @IsString()
  @IsNotEmpty()
  motif!: string;

  @ApiPropertyOptional({ description: 'Date de séance programmée (défaut : +14 jours)' })
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
  @ApiProperty() recoursId!: string;
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
  motif?: string;
}

export class PenaltyDto {
  @ApiProperty({ description: 'Compagnie sanctionnée (doit être partie au recours)' })
  @IsString()
  @IsNotEmpty()
  companyCode!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  amount!: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class SanctionOrderDto {
  @ApiProperty({ description: 'Compagnie sanctionnée (doit être partie au recours)' })
  @IsString()
  @IsNotEmpty()
  companyCode!: string;

  @ApiProperty({ enum: ['AVERTISSEMENT', 'SUSPENSION'] })
  @IsIn(['AVERTISSEMENT', 'SUSPENSION'])
  type!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class PvSignDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ref?: string;
}

export class SanctionViewDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() commissionCaseId?: string;
  @ApiProperty() companyCode!: string;
  @ApiProperty({ enum: SANCTION_TYPES }) type!: string;
  @ApiPropertyOptional() amount?: number;
  @ApiProperty() reason!: string;
  @ApiProperty() orderedAt!: string;
  @ApiProperty() orderedBy!: string;
}

export class ListSanctionsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() company?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize: number = DEFAULT_PAGE_SIZE;
}
