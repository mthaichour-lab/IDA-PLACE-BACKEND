import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { Privilege, Role } from '../common/rbac/roles-privileges';
import { CreatePlaceUserDto, PlaceUserViewDto, UpdatePlaceUserDto } from './dto/place-user.dto';
import { PlaceUser } from './entities/place-user.entity';

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
 * AdminModule.users — écran 14 "Paramétrage" (super admin), B.2/B.3/B.7.
 * CRUD réel (`PlaceUser`, migration, pagination 6/p) : liste, création/
 * édition, compte actif/suspendu, dérogations de privilèges grant/revoke
 * par utilisateur. Repli mémoire en mode dégradé (voir README).
 */
@Injectable()
export class UsersService {
  constructor(@InjectRepository(PlaceUser) private readonly repo: EntityRepository<PlaceUser>) {}

  async list(page: number, pageSize: number): Promise<PaginatedResult<PlaceUserViewDto>> {
    return withDegradedFallback(
      'UsersService.list',
      async () => {
        const [rows, total] = await this.repo.findAndCount({}, { limit: pageSize, offset: (page - 1) * pageSize, orderBy: { name: 'ASC' } });
        return { page, total, items: rows.map(toView) } as PaginatedResult<PlaceUserViewDto>;
      },
      () => paginateArray(MEMORY_USERS, page, pageSize),
    );
  }

  async create(dto: CreatePlaceUserDto): Promise<PlaceUserViewDto> {
    return withDegradedFallback(
      'UsersService.create',
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
      'UsersService.update',
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
}
