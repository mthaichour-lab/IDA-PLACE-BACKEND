import { BadRequestException, CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata, Type as ClassType } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { Reflector } from '@nestjs/core';
import { getMetadataStorage } from 'class-validator';
import { Observable } from 'rxjs';

/**
 * SEC-44 — paramètres de requête STRICTS sur TOUTES les routes (phase 2 de
 * la revue sécurité 2026-10-19 ; auparavant limité au périmètre dossiers).
 *
 * Une clé de query string absente de la déclaration de la route est refusée
 * (400 `PARAMETRE_INCONNU`) au lieu d'être silencieusement retirée par le
 * `ValidationPipe` global (`whitelist: true`) — notamment
 * `?company[$ne]=X` / `?companyId[$ne]=X` (le query parser « simple » du
 * socle les transmet comme clés littérales).
 *
 * Clés autorisées d'un handler, déduites automatiquement de sa signature :
 *  - `@Query() q: UnDto` : propriétés VALIDÉES du DTO (décorateurs
 *    class-validator, héritage compris) — exactement celles que la liste
 *    blanche du `ValidationPipe` conserve ;
 *  - `@Query('cle') v` : la clé nommée ;
 *  - aucun `@Query()` : aucune clé (toute query string est refusée) ;
 *  - `@StrictQuery(Dto)` : remplace la déduction (cas d'un handler qui lirait
 *    la requête autrement).
 *
 * Intercepteur GLOBAL (`APP_INTERCEPTOR`, voir `app.module.ts`) et non pipe :
 * il s'exécute AVANT le pipe global, qui retirerait la clé.
 */

export const STRICT_QUERY_DTO_KEY = 'strict-query:dto';

/** Nombre maximal de clés inconnues renvoyées (et longueur de chacune) dans le 400. */
const MAX_REPORTED_KEYS = 5;
const MAX_REPORTED_KEY_LENGTH = 64;

/** Propriétés validées d'un DTO de requête (celles que conserve `whitelist: true`). */
export function allowedQueryKeys(dto: ClassType<unknown>): string[] {
  const names = getMetadataStorage()
    .getTargetValidationMetadatas(dto, '', true, false)
    .map((m) => m.propertyName);
  return [...new Set(names)];
}

/** `@StrictQuery(Dto)` : déclare explicitement le DTO de query string d'une route (remplace la déduction automatique). */
export const StrictQuery = (dto: ClassType<unknown>) => SetMetadata(STRICT_QUERY_DTO_KEY, dto);

interface RouteArgMetadata {
  index: number;
  data?: unknown;
}

/** Description des paramètres `@Query` d'un handler (utilisée par l'intercepteur et par le test de découverte des routes). */
export interface QueryDeclaration {
  /** Clés autorisées. */
  keys: string[];
  /** `@Query()` entier dont le type n'est pas une classe DTO (aucune clé déductible). */
  untypedWholeQuery: boolean;
}

export function describeQueryDeclaration(controller: ClassType<unknown>, handler: Function, reflector: Reflector = new Reflector()): QueryDeclaration {
  const explicit = reflector.get<ClassType<unknown> | undefined>(STRICT_QUERY_DTO_KEY, handler);
  if (explicit) return { keys: allowedQueryKeys(explicit), untypedWholeQuery: false };

  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handler.name) ?? {}) as Record<string, RouteArgMetadata>;
  const paramTypes = (Reflect.getMetadata('design:paramtypes', controller.prototype as object, handler.name) ?? []) as unknown[];
  const keys = new Set<string>();
  let untypedWholeQuery = false;
  for (const [key, meta] of Object.entries(args)) {
    if (Number(key.split(':')[0]) !== RouteParamtypes.QUERY) continue;
    if (typeof meta.data === 'string' && meta.data.length > 0) {
      keys.add(meta.data);
      continue;
    }
    const type = paramTypes[meta.index];
    if (typeof type !== 'function' || type === Object || type === String || type === Number || type === Boolean || type === Array) {
      untypedWholeQuery = true;
      continue;
    }
    for (const k of allowedQueryKeys(type as ClassType<unknown>)) keys.add(k);
  }
  return { keys: [...keys], untypedWholeQuery };
}

@Injectable()
export class StrictQueryInterceptor implements NestInterceptor {
  private readonly cache = new WeakMap<object, Set<string>>();

  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const handler = ctx.getHandler();
    let allowed = this.cache.get(handler);
    if (!allowed) {
      // Fermé par défaut : un `@Query()` non typé n'ouvre aucune clé (le test de découverte l'interdit de toute façon).
      allowed = new Set(describeQueryDeclaration(ctx.getClass(), handler, this.reflector).keys);
      this.cache.set(handler, allowed);
    }
    const query = (ctx.switchToHttp().getRequest().query ?? {}) as Record<string, unknown>;
    const unknownKeys = Object.keys(query).filter((k) => !allowed.has(k));
    if (unknownKeys.length > 0) {
      throw new BadRequestException({
        code: 'PARAMETRE_INCONNU',
        message: 'Paramètre de requête non reconnu.',
        details: { parametres: unknownKeys.slice(0, MAX_REPORTED_KEYS).map((k) => k.slice(0, MAX_REPORTED_KEY_LENGTH)) },
      });
    }
    return next.handle();
  }
}
