import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsObject, registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { PRIVILEGES, ROLES } from '../../common/rbac/roles-privileges';

/** Vrai si `value` est un patch de matrice `{ rôle connu: { privilège connu: booléen } }`. */
export function isRoleMatrixPatch(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([role, privileges]) =>
      (ROLES as readonly string[]).includes(role) &&
      privileges !== null &&
      typeof privileges === 'object' &&
      !Array.isArray(privileges) &&
      Object.entries(privileges as Record<string, unknown>).every(([p, v]) => (PRIVILEGES as readonly string[]).includes(p) && typeof v === 'boolean'),
  );
}

function IsRoleMatrixPatch(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isRoleMatrixPatch',
      target: object.constructor,
      propertyName,
      options: { message: (args: ValidationArguments) => `${args.property} doit être de la forme { rôle: { privilège: booléen } } avec des rôles et privilèges connus.`, ...options },
      validator: { validate: (value: unknown) => isRoleMatrixPatch(value) },
    });
}

/**
 * SEC-25 — corps typé de `PUT /admin/roles/matrix`. AVANT, le corps était un
 * type TypeScript inline (jamais validé par le `ValidationPipe`) : un corps
 * sans `matrix` provoquait une erreur 500. Désormais 400 explicite.
 * Le plancher « aucun privilège réservé à la place pour un rôle compagnie »
 * est vérifié par `RbacService.previewMatrixChange`.
 */
export class PutRoleMatrixDto {
  @ApiProperty({
    description: 'Patch partiel de la matrice : { rôle: { privilège: booléen } }',
    example: { TRESORIER: { bill: true } },
    type: 'object',
    additionalProperties: true,
  })
  @IsDefined()
  @IsObject()
  @IsRoleMatrixPatch()
  matrix!: Record<string, Record<string, boolean>>;
}
