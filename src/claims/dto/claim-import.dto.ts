import { ApiProperty } from '@nestjs/swagger';

export class ClaimImportRowResultDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty({ enum: ['ELIGIBLE_IDA', 'HORS_IDA'] }) verdict!: 'ELIGIBLE_IDA' | 'HORS_IDA';
  @ApiProperty({ type: [String], description: "Motifs (si HORS_IDA) — articles B.6 cités" })
  reasons!: string[];
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Valeurs des 47 colonnes pour cette ligne' })
  data!: Record<string, unknown>;
}

/** Réponse de `POST /claims/import` — forme STABLE (B.4, B.11). */
export class ClaimImportReportDto {
  @ApiProperty() fileName!: string;
  @ApiProperty() importedAt!: string;
  @ApiProperty() totalRows!: number;
  @ApiProperty() eligibleCount!: number;
  @ApiProperty() ineligibleCount!: number;
  @ApiProperty({ type: [ClaimImportRowResultDto] }) rows!: ClaimImportRowResultDto[];
}

export class ClaimColumnDefDto {
  @ApiProperty() index!: number;
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: ['IDENTIFICATION', 'ELIGIBILITE'] }) group!: string;
  @ApiProperty() type!: string;
  @ApiProperty({ required: false, type: [String] }) enumValues?: string[];
}
