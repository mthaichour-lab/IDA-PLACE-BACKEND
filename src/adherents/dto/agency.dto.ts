import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { AgencyType } from '../entities/agency.entity';
import { CompanyStatus } from '../entities/company.entity';

export class CreateAgencyDto {
  @ApiProperty() @IsUUID() companyId!: string;
  @ApiProperty() @IsString() code!: string;
  @ApiProperty() @IsString() name!: string;
  @ApiProperty({ enum: AgencyType, default: AgencyType.AG }) @IsEnum(AgencyType) type: AgencyType = AgencyType.AG;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;
  @ApiPropertyOptional({ description: 'Code wilaya (01-69)' }) @IsOptional() @IsString() wilayaCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() manager?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
}

export class UpdateAgencyDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional({ enum: AgencyType }) @IsOptional() @IsEnum(AgencyType) type?: AgencyType;
  @ApiPropertyOptional() @IsOptional() @IsString() wilayaCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() manager?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional({ enum: CompanyStatus }) @IsOptional() @IsEnum(CompanyStatus) status?: CompanyStatus;
}

export class AgencyViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: AgencyType }) type!: AgencyType;
  @ApiPropertyOptional() parentId?: string;
  @ApiPropertyOptional() wilayaCode?: string;
  @ApiPropertyOptional() manager?: string;
  @ApiPropertyOptional() phone?: string;
  @ApiPropertyOptional() email?: string;
  @ApiPropertyOptional() address?: string;
  @ApiProperty({ enum: CompanyStatus }) status!: CompanyStatus;
}
