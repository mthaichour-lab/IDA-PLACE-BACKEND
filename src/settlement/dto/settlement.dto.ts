import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CompanyMonthlySynthesisDto {
  @ApiProperty() code!: string;
  @ApiProperty() claimsCount!: number;
  @ApiProperty({ description: 'Nombre de recours résolus (REGLE/REJETE/FORCLOS) sur la période — état d’avancement' })
  resolvedCount!: number;
  @ApiProperty() totalAmount!: number;
  @ApiProperty({ enum: ['EN_COURS', 'CLOTURE'] }) status!: 'EN_COURS' | 'CLOTURE';
  @ApiPropertyOptional() closedAt?: string;
  @ApiPropertyOptional() bordereauRef?: string;
}

export class MonthlySettlementDto {
  @ApiProperty() period!: string;
  @ApiProperty({ type: [CompanyMonthlySynthesisDto] }) companies!: CompanyMonthlySynthesisDto[];
}

export class CloseMonthlyDto {
  @ApiProperty({ description: 'Code de la compagnie dont on clôture la synthèse mensuelle' })
  @IsString()
  @IsNotEmpty()
  company!: string;
}

export class BilateralPositionDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty() amount!: number;
}

export class CompanyNetPositionDto {
  @ApiProperty() code!: string;
  @ApiProperty({ description: 'Positif = la compagnie doit recevoir ; négatif = elle doit payer' }) net!: number;
}

export class QuarterlySettlementDto {
  @ApiProperty() quarter!: string;
  @ApiPropertyOptional() bordereau?: string;
  @ApiProperty({ type: [BilateralPositionDto], description: 'Positions bilatérales nettées (paire par paire)' }) positions!: BilateralPositionDto[];
  @ApiProperty({ type: [CompanyNetPositionDto], description: 'Compensation multilatérale — position nette par compagnie vis-à-vis de la place' }) net!: CompanyNetPositionDto[];
  @ApiPropertyOptional() closedAt?: string;
  @ApiPropertyOptional() closedBy?: string;
}
