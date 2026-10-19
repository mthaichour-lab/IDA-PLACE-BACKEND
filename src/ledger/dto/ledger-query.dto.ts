import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/**
 * SEC-16 — `GET /ledger` : pagination (`pageSize` ≤ 100) et bornes de
 * période au format ISO 8601 strict (une valeur libre était comparée telle
 * quelle aux dates).
 */
export class ListLedgerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: '2026-01-01T00:00:00Z', description: 'Borne basse incluse (ISO 8601)' })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'from doit être une date ISO 8601.' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31T23:59:59Z', description: 'Borne haute incluse (ISO 8601)' })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'to doit être une date ISO 8601.' })
  to?: string;
}
