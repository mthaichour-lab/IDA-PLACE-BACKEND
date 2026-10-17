import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SettlementCompanyLineDto {
  @ApiProperty() company!: string;
  @ApiProperty() claimsSettledCount!: number;
  @ApiProperty() claimsPendingCount!: number;
  @ApiProperty() totalSettledAmount!: number;
  @ApiProperty() totalPendingAmount!: number;
  @ApiProperty() fraisTraitement!: number;
  @ApiProperty({ enum: ['EN_COURS', 'CLOTURE'] }) status!: string;
  @ApiProperty() bordereauRef!: string;
  @ApiProperty() generatedAt!: string;
  @ApiPropertyOptional() closedAt?: string;
}

/** Réponse de `GET /settlement/monthly/:period` — synthèse par compagnie (écran 5). */
export class MonthlySettlementDto {
  @ApiProperty() period!: string;
  @ApiProperty({ type: [SettlementCompanyLineDto] }) companies!: SettlementCompanyLineDto[];
}

export class BilateralPositionDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty() amount!: number;
}

export class NetPositionDto {
  @ApiProperty() company!: string;
  @ApiProperty() net!: number;
}

/** Réponse de `GET /settlement/quarter/:q` — compensation trimestrielle (écran 6). */
export class QuarterCompensationDto {
  @ApiProperty() quarter!: string;
  @ApiProperty() bordereau!: string;
  @ApiProperty({ type: [BilateralPositionDto] }) positions!: BilateralPositionDto[];
  @ApiProperty({ type: [NetPositionDto] }) net!: NetPositionDto[];
  @ApiProperty({ enum: ['CALCULE', 'SCELLE'] }) status!: string;
  @ApiProperty() generatedAt!: string;
  @ApiPropertyOptional() sealedAt?: string;
}
