import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Pagination standard de l'API — B.11 : `{page, total, items}`, 6/p par défaut côté UI. */
export const DEFAULT_PAGE_SIZE = 6;
/** SEC-13 — taille de page maximale acceptée (`?pageSize=100000` → 400). */
export const MAX_PAGE_SIZE = 100;

export class PaginationQueryDto {
  @ApiProperty({ required: false, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiProperty({ required: false, default: DEFAULT_PAGE_SIZE, minimum: 1, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize: number = DEFAULT_PAGE_SIZE;
}

export class PaginatedResult<T> {
  @ApiProperty() page: number;
  @ApiProperty() total: number;
  items: T[];

  constructor(items: T[], total: number, page: number) {
    this.items = items;
    this.total = total;
    this.page = page;
  }
}

export function paginateArray<T>(all: T[], page = 1, pageSize = DEFAULT_PAGE_SIZE): PaginatedResult<T> {
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * pageSize;
  return new PaginatedResult(all.slice(start, start + pageSize), all.length, safePage);
}
