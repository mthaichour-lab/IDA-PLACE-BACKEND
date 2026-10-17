import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination.dto';
import { PRIVILEGES, ROLES } from '../../common/rbac/roles-privileges';

export class ListPlaceUsersQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize: number = DEFAULT_PAGE_SIZE;
}

export class CreatePlaceUserDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES as unknown as string[]) role!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() companyId?: string;
  @ApiPropertyOptional({ type: [String], enum: PRIVILEGES }) @IsOptional() @IsArray() @IsIn(PRIVILEGES as unknown as string[], { each: true }) grant?: string[];
  @ApiPropertyOptional({ type: [String], enum: PRIVILEGES }) @IsOptional() @IsArray() @IsIn(PRIVILEGES as unknown as string[], { each: true }) revoke?: string[];
}

export class UpdatePlaceUserDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional({ enum: ROLES }) @IsOptional() @IsIn(ROLES as unknown as string[]) role?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional({ type: [String], enum: PRIVILEGES }) @IsOptional() @IsArray() @IsIn(PRIVILEGES as unknown as string[], { each: true }) grant?: string[];
  @ApiPropertyOptional({ type: [String], enum: PRIVILEGES }) @IsOptional() @IsArray() @IsIn(PRIVILEGES as unknown as string[], { each: true }) revoke?: string[];
}

export class PlaceUserViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ROLES }) role!: string;
  @ApiPropertyOptional() companyId?: string;
  @ApiProperty() active!: boolean;
  @ApiProperty({ type: [String] }) grant!: string[];
  @ApiProperty({ type: [String] }) revoke!: string[];
}
