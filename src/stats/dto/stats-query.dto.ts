import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** `GET /stats/wilayas?year=` — année bornée (SEC-44). */
export class StatsWilayasQueryDto {
  @ApiPropertyOptional({ minimum: 1900, maximum: 2100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1900) @Max(2100) year?: number;
}
