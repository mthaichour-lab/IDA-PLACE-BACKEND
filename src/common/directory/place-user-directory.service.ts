import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CreatePlaceUserDto, PlaceUserViewDto, UpdatePlaceUserDto } from '../../admin/dto/place-user.dto';
import { paginateArray, PaginatedResult } from '../dto/pagination.dto';
import { withDegradedFallback } from '../interfaces/degraded-mode';
import { forbiddenPrivilegesForRole, isCompanyScopedRole, Privilege, Role, ROLES } from '../rbac/roles-privileges';
import { PlaceUser } from './place-user.entity';

/** Repli mémoire — mode dégradé (voir README "Mode dégradé"). Seed identique à l'ancien mock, pour ne pas changer le comportement observé en dev sans base. */
const MEMORY_USERS: PlaceUserViewDto[] = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Opérateur Place (dev)', email: 'operateur@finlab.dz', role: 'OPERATEUR_PLACE', active: true, grant: [], revoke: [] },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Correspondant CAAT', email: 'correspondant@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'CAAT', active: true, grant: [], revoke: [] },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Trésorier SAA', email: 'tresorier@saa.dz', role: 'TRESORIER', companyId: 'SAA', active: false, grant: [], revoke: [] },
];

/** Repli mémoire : liaison `sub` Keycloak par utilisateur (équivalent de la colonne `keycloak_sub`). */
const MEMORY_SUBS = new Map<string, string>();

/** SEC-09 — état d'un compte applicatif pour une identité Keycloak (voir `lookupAccount`). */
export type PlaceUserAccountLookup =
  | { status: 'UNKNOWN' }
  | { status: 'SUB_MISMATCH'; userId: string }
  | { status: 'INACTIVE'; userId: string }
  | { status: 'ACTIVE'; userId: string; grant: Privilege[]; revoke: Privilege[] };

function accountStatus(u: { id: string; active: boolean; grant: string[]; revoke: string[] }): PlaceUserAccountLookup {
  if (!u.active) return { status: 'INACTIVE', userId: u.id };
  return { status: 'ACTIVE', userId: u.id, grant: [...u.grant] as Privilege[], revoke: [...u.revoke] as Privilege[] };
}

/**
 * SEC-25 — plancher de séparation des tâches pour les dérogations
 * individuelles : un rôle de compagnie ne peut recevoir aucun privilège
 * réservé à la place par `grant`, et doit être rattaché à une compagnie.
 * Vérifié sur l'état RÉSULTANT (rôle et grant après fusion du patch).
 */
function assertAccountConsistency(role: string, grant: readonly string[], companyId: string | undefined): void {
  const forbidden = forbiddenPrivilegesForRole(role, grant);
  if (forbidden.length > 0) {
    throw new BadRequestException({
      code: 'PRIVILEGE_RESERVE_PLACE',
      message: `Privilège(s) réservé(s) aux rôles de place, interdit(s) pour le rôle ${role} : ${forbidden.join(', ')}.`,
    });
  }
  if (isCompanyScopedRole(role) && !companyId) {
    throw new BadRequestException({ code: 'BAD_REQUEST', message: `Le rôle ${role} doit être rattaché à une compagnie (companyId).` });
  }
  // Séparation place / compagnies : un compte de la place (opérateur, Admin
  // FinLab/UAR, commission, audit) n'est jamais rattaché à une compagnie —
  // sinon il cumulerait la vue « toute la place » et des actes de compagnie.
  if (!isCompanyScopedRole(role) && companyId) {
    throw new BadRequestException({ code: 'COMPTE_PLACE_AVEC_COMPAGNIE', message: `Le rôle ${role} est un rôle de la place : il ne peut pas être rattaché à une compagnie (${companyId}).` });
  }
}

/** Passage d'un rôle compagnie à un rôle de la place : le rattachement à la compagnie tombe avec l'ancien rôle. */
function resultingCompanyId(role: string, patchCompanyId: string | undefined, currentCompanyId: string | undefined): string | undefined {
  if (!isCompanyScopedRole(role)) return patchCompanyId;
  return patchCompanyId ?? currentCompanyId;
}

function toView(u: PlaceUser): PlaceUserViewDto {
  return { id: u.id, name: u.name, email: u.email, role: u.role, companyId: u.companyId, active: u.active, grant: u.grant, revoke: u.revoke };
}

/**
 * ⚠️ Pré-requis avant tout `assign(entity, dto)` (MikroORM OU `Object.assign`
 * brut) : avec `target >= ES2022` (voir tsconfig.json) et
 * `useDefineForClassFields` (actif par défaut pour cette cible), TOUT champ
 * de classe déclaré (ex. `name?: string;`) devient une propriété PROPRE de
 * l'instance, valant `undefined`, MÊME s'il n'a pas été fourni dans le JSON
 * reçu. `class-transformer` (`ValidationPipe({transform:true})`) instancie
 * `UpdatePlaceUserDto` ainsi : `Object.keys(dto)` contient donc TOUJOURS
 * `name`/`email`/`role`/`companyId`/`grant`/`revoke`, même absents de la
 * requête — `Object.assign(cible, dto)` écrase alors silencieusement les
 * champs non fournis avec `undefined` (reproduit et confirmé pendant ce
 * sprint — voir rapport de fin de sprint). On ne passe donc jamais le DTO
 * brut à `assign()` : on filtre d'abord les clés réellement fournies.
 */
function definedFieldsOnly<T extends object>(dto: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(dto) as (keyof T)[]) {
    if (dto[key] !== undefined) result[key] = dto[key];
  }
  return result;
}

/**
 * PlaceUserDirectory — source unique des `PlaceUser` (B.3), extraite dans
 * `common/directory` (et non `admin`) précisément pour être consommée par
 * DEUX modules qui ne doivent pas dépendre l'un de l'autre :
 *  - `AdminModule` (écran 14 "Paramétrage") : CRUD complet (`list`/`create`/
 *    `update`), sans changement de comportement vis-à-vis de l'ancien
 *    `UsersService` qu'elle remplace.
 *  - `AuthModule` (`KeycloakStrategy`) : état du compte et dérogations
 *    grant/revoke d'une identité Keycloak via `lookupAccount`
 *    — avant cette extraction, consommer `UsersService` depuis `AuthModule`
 *    aurait créé une dépendance inverse `AuthModule` → `AdminModule`
 *    (`AdminModule` important déjà `AuthModule` pour ses guards), impossible
 *    sans `forwardRef`. Voir ARCHITECTURE.md §3 et HANDOFF.md.
 */
@Injectable()
export class PlaceUserDirectory {
  constructor(@InjectRepository(PlaceUser) private readonly repo: EntityRepository<PlaceUser>) {}

  async list(page: number, pageSize: number, scope?: 'PLACE' | 'COMPAGNIE'): Promise<PaginatedResult<PlaceUserViewDto>> {
    const companyRoles = ROLES.filter((r) => isCompanyScopedRole(r));
    const where = scope === 'COMPAGNIE' ? { role: { $in: companyRoles } } : scope === 'PLACE' ? { role: { $nin: companyRoles } } : {};
    const inScope = (u: PlaceUserViewDto) => !scope || (scope === 'COMPAGNIE') === isCompanyScopedRole(u.role);
    return withDegradedFallback(
      'PlaceUserDirectory.list',
      async () => {
        const [rows, total] = await this.repo.findAndCount(where, { limit: pageSize, offset: (page - 1) * pageSize, orderBy: { name: 'ASC' } });
        return { page, total, items: rows.map(toView) } as PaginatedResult<PlaceUserViewDto>;
      },
      () => paginateArray(MEMORY_USERS.filter(inScope), page, pageSize),
    );
  }

  async create(dto: CreatePlaceUserDto): Promise<PlaceUserViewDto> {
    assertAccountConsistency(dto.role, dto.grant ?? [], dto.companyId);
    return withDegradedFallback(
      'PlaceUserDirectory.create',
      async () => {
        const existing = await this.repo.findOne({ email: dto.email });
        if (existing) throw new ConflictException({ code: 'CONFLICT', message: 'Un utilisateur avec cet email existe déjà.' });
        const u = this.repo.create({
          name: dto.name,
          email: dto.email,
          role: dto.role as Role,
          companyId: dto.companyId,
          grant: (dto.grant ?? []) as Privilege[],
          revoke: (dto.revoke ?? []) as Privilege[],
          active: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await this.repo.getEntityManager().persistAndFlush(u);
        return toView(u);
      },
      () => {
        if (MEMORY_USERS.some((u) => u.email === dto.email)) {
          throw new ConflictException({ code: 'CONFLICT', message: 'Un utilisateur avec cet email existe déjà (mode dégradé).' });
        }
        const user: PlaceUserViewDto = {
          id: randomUUID(),
          name: dto.name,
          email: dto.email,
          role: dto.role,
          companyId: dto.companyId,
          active: true,
          grant: dto.grant ?? [],
          revoke: dto.revoke ?? [],
        };
        MEMORY_USERS.push(user);
        return user;
      },
    );
  }

  async update(id: string, dto: UpdatePlaceUserDto): Promise<PlaceUserViewDto> {
    const patch = definedFieldsOnly(dto);
    return withDegradedFallback(
      'PlaceUserDirectory.update',
      async () => {
        const u = await this.repo.findOne({ id });
        if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Utilisateur introuvable.' });
        const companyId = resultingCompanyId(patch.role ?? u.role, patch.companyId, u.companyId);
        assertAccountConsistency(patch.role ?? u.role, patch.grant ?? u.grant, companyId);
        this.repo.assign(u, { ...patch, companyId } as Partial<PlaceUser>);
        await this.repo.getEntityManager().flush();
        return toView(u);
      },
      () => {
        const u = MEMORY_USERS.find((m) => m.id === id);
        if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Utilisateur introuvable (mode dégradé).' });
        const companyId = resultingCompanyId(patch.role ?? u.role, patch.companyId, u.companyId);
        assertAccountConsistency(patch.role ?? u.role, patch.grant ?? u.grant, companyId);
        Object.assign(u, patch, { companyId });
        return u;
      },
    );
  }

  /**
   * SEC-09/SEC-24 (revue sécurité 2026-10-19) — état du compte applicatif
   * d'une identité Keycloak, consommé par `KeycloakStrategy` à CHAQUE requête
   * (une suspension ou un `revoke` s'applique donc immédiatement).
   *
   * AVANT : `findActiveDerogationsByEmail` renvoyait `null` aussi bien pour
   * un utilisateur inconnu que pour un utilisateur SUSPENDU — la stratégie
   * appliquait alors le rôle seul, sans les `revoke` : un agent suspendu
   * localement restait connecté avec tous les privilèges de son rôle.
   *
   * Résolution :
   *  1. par `sub` Keycloak si un compte y est déjà lié ;
   *  2. sinon par e-mail, UNIQUEMENT si l'e-mail est vérifié par Keycloak ;
   *     le compte trouvé est alors lié à ce `sub` (première connexion) ; s'il
   *     est déjà lié à un AUTRE `sub` → `SUB_MISMATCH` (refus) ;
   *  3. sinon `UNKNOWN` (miroir non synchronisé : rôle du jeton seul).
   */
  async lookupAccount(identity: { sub: string; email?: string; emailVerified: boolean }): Promise<PlaceUserAccountLookup> {
    const email = identity.email?.trim();
    return withDegradedFallback(
      'PlaceUserDirectory.lookupAccount',
      async () => {
        const bySub = await this.repo.findOne({ keycloakSub: identity.sub });
        if (bySub) return accountStatus(bySub);
        if (!email || !identity.emailVerified) return { status: 'UNKNOWN' } as const;
        const byEmail = await this.repo.findOne({ email: { $in: [...new Set([email, email.toLowerCase()])] } });
        if (!byEmail) return { status: 'UNKNOWN' } as const;
        if (byEmail.keycloakSub && byEmail.keycloakSub !== identity.sub) return { status: 'SUB_MISMATCH', userId: byEmail.id } as const;
        if (!byEmail.keycloakSub) {
          byEmail.keycloakSub = identity.sub;
          await this.repo.getEntityManager().flush();
        }
        return accountStatus(byEmail);
      },
      () => {
        const bySub = MEMORY_USERS.find((m) => MEMORY_SUBS.get(m.id) === identity.sub);
        if (bySub) return accountStatus(bySub);
        if (!email || !identity.emailVerified) return { status: 'UNKNOWN' } as const;
        const byEmail = MEMORY_USERS.find((m) => m.email === email || m.email === email.toLowerCase());
        if (!byEmail) return { status: 'UNKNOWN' } as const;
        const bound = MEMORY_SUBS.get(byEmail.id);
        if (bound && bound !== identity.sub) return { status: 'SUB_MISMATCH', userId: byEmail.id } as const;
        MEMORY_SUBS.set(byEmail.id, identity.sub);
        return accountStatus(byEmail);
      },
    );
  }
}
