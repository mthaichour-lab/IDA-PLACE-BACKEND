import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CreatePlaceUserDto, PlaceUserViewDto, UpdatePlaceUserDto } from '../../admin/dto/place-user.dto';
import { paginateArray, PaginatedResult } from '../dto/pagination.dto';
import { withDegradedFallback } from '../interfaces/degraded-mode';
import { Privilege, Role } from '../rbac/roles-privileges';
import { PlaceUser } from './place-user.entity';

/** Repli mémoire — mode dégradé (voir README "Mode dégradé"). Seed identique à l'ancien mock, pour ne pas changer le comportement observé en dev sans base. */
const MEMORY_USERS: PlaceUserViewDto[] = [
  { id: 'u-1', name: 'Opérateur Place (dev)', email: 'operateur@finlab.dz', role: 'OPERATEUR_PLACE', active: true, grant: [], revoke: [] },
  { id: 'u-2', name: 'Correspondant CAAT', email: 'correspondant@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'CAAT', active: true, grant: [], revoke: [] },
  { id: 'u-3', name: 'Trésorier SAA', email: 'tresorier@saa.dz', role: 'TRESORIER', companyId: 'SAA', active: false, grant: [], revoke: [] },
];

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
 *  - `AuthModule` (`KeycloakStrategy`) : lecture seule des dérogations
 *    grant/revoke d'un utilisateur authentifié via `findActiveDerogationsByEmail`
 *    — avant cette extraction, consommer `UsersService` depuis `AuthModule`
 *    aurait créé une dépendance inverse `AuthModule` → `AdminModule`
 *    (`AdminModule` important déjà `AuthModule` pour ses guards), impossible
 *    sans `forwardRef`. Voir ARCHITECTURE.md §3 et HANDOFF.md.
 */
@Injectable()
export class PlaceUserDirectory {
  constructor(@InjectRepository(PlaceUser) private readonly repo: EntityRepository<PlaceUser>) {}

  async list(page: number, pageSize: number): Promise<PaginatedResult<PlaceUserViewDto>> {
    return withDegradedFallback(
      'PlaceUserDirectory.list',
      async () => {
        const [rows, total] = await this.repo.findAndCount({}, { limit: pageSize, offset: (page - 1) * pageSize, orderBy: { name: 'ASC' } });
        return { page, total, items: rows.map(toView) } as PaginatedResult<PlaceUserViewDto>;
      },
      () => paginateArray(MEMORY_USERS, page, pageSize),
    );
  }

  async create(dto: CreatePlaceUserDto): Promise<PlaceUserViewDto> {
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
        this.repo.assign(u, patch as Partial<PlaceUser>);
        await this.repo.getEntityManager().flush();
        return toView(u);
      },
      () => {
        const u = MEMORY_USERS.find((m) => m.id === id);
        if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Utilisateur introuvable (mode dégradé).' });
        Object.assign(u, patch);
        return u;
      },
    );
  }

  /**
   * Lecture seule, consommée par `KeycloakStrategy` (B.7) pour appliquer les
   * dérogations grant/revoke d'un utilisateur authentifié via Keycloak — le
   * rôle/les privilèges de base viennent du token (realm_access.roles /
   * ida_place_role), mais les dérogations PAR UTILISATEUR ne vivent que dans
   * ce miroir applicatif `PlaceUser`, pas dans Keycloak.
   *
   * Retourne `null` si aucun `PlaceUser` ne correspond à cet email (ce
   * miroir n'est pas forcément synchronisé pour tous les utilisateurs
   * Keycloak) OU si le compte est suspendu (`active:false`) — dans les deux
   * cas, l'appelant (`KeycloakStrategy`) applique alors le rôle seul, sans
   * dérogation. Keycloak reste la seule source de vérité pour
   * l'authentification elle-même : ce miroir ne peut donc PAS rejeter une
   * authentification, seulement moduler les privilèges d'un rôle déjà admis.
   */
  async findActiveDerogationsByEmail(email: string): Promise<{ grant: Privilege[]; revoke: Privilege[] } | null> {
    return withDegradedFallback(
      'PlaceUserDirectory.findActiveDerogationsByEmail',
      async () => {
        const u = await this.repo.findOne({ email });
        if (!u || !u.active) return null;
        return { grant: u.grant, revoke: u.revoke };
      },
      () => {
        const u = MEMORY_USERS.find((m) => m.email === email);
        if (!u || !u.active) return null;
        return { grant: u.grant as Privilege[], revoke: u.revoke as Privilege[] };
      },
    );
  }
}
