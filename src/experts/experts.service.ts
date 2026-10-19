import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { resolveTenantFilter } from '../common/rbac/tenant-scope';
import { LedgerService } from '../ledger/ledger.service';
import { isPlaceUser } from '../recours/place-role';
import { withStrictFallback } from '../recours/strict-persistence';
import { CreateExpertDto, ExpertViewDto, UpdateExpertDto } from './dto/expert.dto';
import { Expert, ExpertStatus } from './entities/expert.entity';
import { encryptRib, parseRibKey, ribLast4 } from './rib-cipher';

/** Repli mémoire (mode dégradé) — identifiants au format UUID, comme en base (SEC-44). */
type MemoryExpert = ExpertViewDto & { ribLast4?: string };

const MEMORY_EXPERTS: MemoryExpert[] = [
  { id: '3b6f2c1e-0c1a-4a7e-8e01-0000000000e1', name: 'Karim Belkacem', firm: 'Cabinet Belkacem', agrement: 'AGR-2019-0042', wilayas: ['16', '09'], specialties: ['Carrosserie'], companies: ['CAAT', 'SAA'], status: ExpertStatus.ACTIF },
  { id: '3b6f2c1e-0c1a-4a7e-8e01-0000000000e2', name: 'Yasmine Ould Ali', firm: 'Expertise Auto Est', agrement: 'AGR-2021-0117', wilayas: ['25', '19'], specialties: ['Mécanique', 'Carrosserie'], companies: ['CASH'], status: ExpertStatus.ACTIF },
];

/** Champs descriptifs d'un expert (affectation champ par champ, jamais `assign(dto)`). */
const DESCRIPTIVE_FIELDS = ['name', 'firm', 'agrement', 'wilayas', 'specialties'] as const;

function toView(e: Expert): MemoryExpert {
  return { id: e.id, name: e.name, firm: e.firm, agrement: e.agrement, wilayas: e.wilayas, specialties: e.specialties, companies: e.companies, status: e.status, ribLast4: e.ribLast4 };
}

const forbidden = (message: string) => new ForbiddenException({ code: 'FORBIDDEN', message });

/**
 * ExpertsModule — B.2 : registre des experts de place. Écran 12.
 *
 * Revue sécurité 2026-10-19 :
 *  - SEC-14 : un expert est PARTAGÉ entre compagnies. Un rôle compagnie ne peut
 *    qu'ajouter ou retirer SON propre code dans `companies` ; le statut global
 *    (ACTIF/SUSPENDU/RADIE) est réservé aux rôles place ; les champs descriptifs
 *    d'un expert servant aussi d'autres compagnies ne sont modifiables que par
 *    la place. Chaque modification est scellée au journal ;
 *  - SEC-26 : un rôle compagnie ne voit que les experts qui la servent, sans la
 *    liste des autres compagnies servies ;
 *  - SEC-49 : RIB chiffré (AES-256-GCM, `EXPERT_RIB_KEY`), jamais stocké en clair.
 */
@Injectable()
export class ExpertsService {
  private readonly ribKey?: Buffer;

  constructor(
    @InjectRepository(Expert) private readonly repo: EntityRepository<Expert>,
    @Optional() configService?: ConfigService,
    @Optional() private readonly ledger?: LedgerService,
  ) {
    this.ribKey = parseRibKey(configService?.get<string>('EXPERT_RIB_KEY'));
  }

  private async seal(type: string, ref: string, actorId: string, summary: Record<string, unknown>): Promise<void> {
    if (this.ledger) await this.ledger.append(type, ref, actorId, JSON.stringify(summary));
  }

  /** SEC-26 : projection selon l'appelant (rôle compagnie : sa seule compagnie dans `companies`, pas de RIB). */
  private project(e: MemoryExpert, user?: AuthenticatedUser): ExpertViewDto {
    const { ribLast4: last4, ...view } = e;
    if (!user || isPlaceUser(user)) return { ...view, ...(last4 ? { ribMasked: `••••${last4}` } : {}) };
    const tenant = resolveTenantFilter(user);
    return { ...view, companies: view.companies.filter((c) => c === tenant) };
  }

  async list(page: number, pageSize: number, user?: AuthenticatedUser): Promise<PaginatedResult<ExpertViewDto>> {
    const tenant = user ? resolveTenantFilter(user) : undefined;
    const result = await withDegradedFallback(
      'ExpertsService.list',
      async () => {
        const where = tenant ? { companies: { $contains: [tenant] } } : {};
        const [rows, total] = await this.repo.findAndCount(where, { limit: pageSize, offset: (page - 1) * pageSize, orderBy: { name: 'ASC' } });
        return { page, total, items: rows.map(toView) } as PaginatedResult<MemoryExpert>;
      },
      () => paginateArray(tenant ? MEMORY_EXPERTS.filter((e) => e.companies.includes(tenant)) : MEMORY_EXPERTS, page, pageSize),
    );
    return { ...result, items: result.items.map((e) => this.project(e, user)) };
  }

  private encrypt(rib: string | undefined): { rib?: string; ribLast4?: string } {
    if (rib === undefined) return {};
    if (!this.ribKey) {
      throw new BadRequestException({ code: 'RIB_NON_CHIFFRABLE', message: 'Le chiffrement des RIB n’est pas configuré (EXPERT_RIB_KEY) : RIB refusé plutôt que stocké en clair.' });
    }
    return { rib: encryptRib(rib, this.ribKey), ribLast4: ribLast4(rib) };
  }

  /** SEC-14 : un rôle compagnie ne crée un expert que pour SA compagnie (aucune concurrente rattachée d'office). */
  async create(dto: CreateExpertDto, user: AuthenticatedUser): Promise<ExpertViewDto> {
    const companies = dto.companies ?? [];
    if (!isPlaceUser(user)) {
      const tenant = resolveTenantFilter(user);
      if (companies.length !== 1 || companies[0] !== tenant) throw forbidden('Une compagnie ne peut rattacher un expert qu’à elle-même.');
    }
    const secret = this.encrypt(dto.rib);
    const created = await withStrictFallback(
      'ExpertsService.create',
      async () => {
        const e = this.repo.create({
          name: dto.name,
          firm: dto.firm,
          agrement: dto.agrement,
          wilayas: dto.wilayas ?? [],
          specialties: dto.specialties ?? [],
          companies,
          ...secret,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await this.repo.getEntityManager().persistAndFlush(e);
        return toView(e);
      },
      () => {
        const view: MemoryExpert = {
          id: randomUUID(),
          name: dto.name,
          firm: dto.firm,
          agrement: dto.agrement,
          wilayas: dto.wilayas ?? [],
          specialties: dto.specialties ?? [],
          companies,
          status: ExpertStatus.ACTIF,
          ribLast4: secret.ribLast4,
        };
        MEMORY_EXPERTS.push(view);
        return view;
      },
    );
    await this.seal('EXPERT_CREE', created.id, user.id, { companies, role: user.role });
    return this.project(created, user);
  }

  /** Lecture de l'expert (base, puis repli mémoire) — pour le contrôle d'accès, hors de toute écriture. */
  private async current(id: string): Promise<MemoryExpert> {
    try {
      const e = await this.repo.findOne({ id });
      if (e) return toView(e);
    } catch {
      // base injoignable : repli mémoire ci-dessous
    }
    const e = MEMORY_EXPERTS.find((m) => m.id === id);
    if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Expert introuvable.' });
    return e;
  }

  /**
   * SEC-14 — règles pour un rôle compagnie :
   *  - l'expert doit déjà la servir (404 sinon : un expert d'autres compagnies n'est pas visible) ;
   *  - `companies` : seul SON code peut être ajouté ou retiré ;
   *  - `status` : réservé à la place (statut global, commun à toutes les compagnies) ;
   *  - champs descriptifs : seulement si l'expert ne sert qu'elle.
   */
  async update(id: string, dto: UpdateExpertDto, user: AuthenticatedUser): Promise<ExpertViewDto> {
    const existing = await this.current(id);
    // Copie : en mode dégradé, `existing` est la ligne mémoire elle-même, mutée par l'écriture.
    const before = { companies: [...existing.companies], status: existing.status };
    const place = isPlaceUser(user);
    if (!place) {
      const tenant = resolveTenantFilter(user)!;
      if (!existing.companies.includes(tenant)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Expert introuvable.' });
      if (dto.status !== undefined) throw forbidden('Le statut d’un expert est commun à toute la place : réservé aux rôles de la place.');
      if (dto.companies !== undefined) {
        const before = new Set(existing.companies);
        const after = new Set(dto.companies);
        const changed = [...existing.companies.filter((c) => !after.has(c)), ...dto.companies.filter((c) => !before.has(c))];
        if (changed.some((c) => c !== tenant)) throw forbidden('Une compagnie ne peut ajouter ou retirer que son propre rattachement.');
      }
      const touchesDescriptive = DESCRIPTIVE_FIELDS.some((f) => dto[f] !== undefined) || dto.rib !== undefined;
      if (touchesDescriptive && existing.companies.some((c) => c !== tenant)) {
        throw forbidden('Cet expert sert d’autres compagnies : sa fiche n’est modifiable que par la place.');
      }
    }
    const patch: Record<string, unknown> = {};
    for (const f of DESCRIPTIVE_FIELDS) if (dto[f] !== undefined) patch[f] = dto[f];
    if (dto.companies !== undefined) patch.companies = [...new Set(dto.companies)];
    if (dto.status !== undefined) patch.status = dto.status;
    const secret = this.encrypt(dto.rib);
    const updated = await withStrictFallback(
      'ExpertsService.update',
      async () => {
        const e = await this.repo.findOne({ id });
        if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Expert introuvable.' });
        for (const [k, v] of Object.entries({ ...patch, ...secret })) (e as unknown as Record<string, unknown>)[k] = v;
        await this.repo.getEntityManager().flush();
        return toView(e);
      },
      () => {
        const e = MEMORY_EXPERTS.find((m) => m.id === id);
        if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Expert introuvable (mode dégradé).' });
        for (const [k, v] of Object.entries(patch)) (e as unknown as Record<string, unknown>)[k] = v;
        if (secret.ribLast4) e.ribLast4 = secret.ribLast4;
        return e;
      },
    );
    await this.seal('EXPERT_MODIFIE', id, user.id, {
      role: user.role,
      fields: [...Object.keys(patch), ...(secret.rib ? ['rib'] : [])],
      companiesBefore: before.companies,
      companiesAfter: updated.companies,
      statusBefore: before.status,
      statusAfter: updated.status,
    });
    return this.project(updated, user);
  }
}
