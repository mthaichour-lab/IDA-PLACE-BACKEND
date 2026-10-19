import { applyDecorators, BadRequestException, CallHandler, ExecutionContext, NestInterceptor, Type as ClassType, UseInterceptors } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { getMetadataStorage, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { Observable } from 'rxjs';
import { COMPANY_CODE_PATTERN } from './claim-import.dto';

/**
 * SEC-44 — paramètres de requête STRICTS sur les routes du périmètre
 * dossiers : une clé absente du DTO est refusée (400 PARAMETRE_INCONNU) au
 * lieu d'être silencieusement retirée par le `ValidationPipe` global —
 * notamment `?company[$ne]=X` / `?companyId[$ne]=X` (le query parser
 * « simple » du socle les transmet comme clés littérales). Intercepteur et
 * non pipe : il s'exécute AVANT le pipe global, qui retirerait la clé.
 */
class RejectUnknownQueryInterceptor implements NestInterceptor {
  private readonly allowed: Set<string>;

  constructor(dto: ClassType<unknown>) {
    this.allowed = new Set(getMetadataStorage().getTargetValidationMetadatas(dto, '', true, false).map((m) => m.propertyName));
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const query = (ctx.switchToHttp().getRequest().query ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(query).filter((k) => !this.allowed.has(k));
    if (unknown.length > 0) {
      throw new BadRequestException({ code: 'PARAMETRE_INCONNU', message: 'Paramètre de requête non reconnu.', details: { parametres: unknown.slice(0, 5) } });
    }
    return next.handle();
  }
}

/** `@StrictQuery(Dto)` sur une route : refuse toute clé de requête hors du DTO. */
export function StrictQuery(dto: ClassType<unknown>): MethodDecorator & ClassDecorator {
  return applyDecorators(UseInterceptors(new RejectUnknownQueryInterceptor(dto)));
}

/** `:company` d'une route : code compagnie du référentiel. */
export class CompanyParamDto {
  @Matches(COMPANY_CODE_PATTERN, { message: 'company : code compagnie attendu.' }) company!: string;
}

/** `:code` d'une route : code compagnie du référentiel. */
export class CompanyCodeParamDto {
  @Matches(COMPANY_CODE_PATTERN, { message: 'code : code compagnie attendu.' }) code!: string;
}

/** `GET /stats/wilayas?year=` — année bornée. */
export class StatsWilayasQueryDto {
  @ApiPropertyOptional({ minimum: 1900, maximum: 2100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1900) @Max(2100) year?: number;
}
