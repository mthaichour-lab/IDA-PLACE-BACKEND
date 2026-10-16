import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
import { ExpertStatus } from '../entities/expert.entity';

export class CreateExpertDto {
  @ApiProperty() @IsString() name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() firm?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() agrement?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() wilayas?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() specialties?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() companies?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() rib?: string;
}

export class UpdateExpertDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() firm?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() agrement?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() wilayas?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() specialties?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() companies?: string[];
  @ApiPropertyOptional({ enum: ExpertStatus }) @IsOptional() @IsEnum(ExpertStatus) status?: ExpertStatus;
}

export class ExpertViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() firm?: string;
  @ApiPropertyOptional() agrement?: string;
  @ApiProperty({ type: [String] }) wilayas!: string[];
  @ApiProperty({ type: [String] }) specialties!: string[];
  @ApiProperty({ type: [String] }) companies!: string[];
  @ApiProperty({ enum: ExpertStatus }) status!: ExpertStatus;
}
