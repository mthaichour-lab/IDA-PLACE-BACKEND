import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FRAUD_ACTION_TYPES } from '../entities/fraud-action.entity';

export const FRAUD_CASE_TYPES = ['DOUBLON', 'ECONSTAT_REUTILISE', 'RECURRENCE_VEHICULE', 'MONTANT_CALIBRE', 'INCOHERENCE_AB'] as const;
export const FRAUD_SEVERITIES = ['FAIBLE', 'MOYENNE', 'ELEVEE'] as const;

export class FraudCaseViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: FRAUD_CASE_TYPES }) type!: string;
  @ApiProperty() score!: number;
  @ApiProperty({ enum: FRAUD_SEVERITIES }) severity!: string;
  @ApiProperty({ type: [String] }) claimIds!: string[];
  @ApiProperty({ type: [String] }) companiesInvolved!: string[];
  @ApiProperty({ type: Object }) details!: Record<string, unknown>;
  @ApiProperty() detectedAt!: string;
}

export class FraudActionViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: FRAUD_ACTION_TYPES }) type!: string;
  @ApiProperty() actor!: string;
  @ApiPropertyOptional() claimId?: string;
  @ApiPropertyOptional() matchId?: string;
  @ApiPropertyOptional({ type: Object }) details?: Record<string, unknown>;
  @ApiProperty() at!: string;
}
