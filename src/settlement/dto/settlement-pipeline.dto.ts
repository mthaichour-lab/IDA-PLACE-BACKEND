import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PIPELINE_STEPS } from '../settlement-pipeline.rules';

export class PipelineStepViewDto {
  @ApiProperty({ enum: PIPELINE_STEPS }) step!: (typeof PIPELINE_STEPS)[number];
  @ApiProperty() label!: string;
  @ApiProperty({ description: 'Référence de la convention IDA' }) article!: string;
  @ApiProperty({ enum: ['DONE', 'EN_COURS', 'A_VENIR'] }) status!: 'DONE' | 'EN_COURS' | 'A_VENIR';
  @ApiProperty({ description: 'Échéance AAAA-MM-JJ' }) dueDate!: string;
  @ApiProperty({ description: "Non réalisée et aujourd'hui > échéance" }) overdue!: boolean;
  @ApiPropertyOptional() completedAt?: string;
  @ApiPropertyOptional() completedBy?: string;
  @ApiPropertyOptional() note?: string;
}

export class QuarterlyPipelineDto {
  @ApiProperty() quarter!: string;
  @ApiProperty({ type: [PipelineStepViewDto] }) steps!: PipelineStepViewDto[];
}

export class CompletePipelineStepDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
