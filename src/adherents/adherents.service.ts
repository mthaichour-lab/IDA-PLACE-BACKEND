import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { assertCompanyAccess, resolveTenantFilter } from '../common/rbac/tenant-scope';
import { DEFAULT_ELIGIBILITY_CONFIG } from '../eligibility/eligibility.rules';
import { LedgerService } from '../ledger/ledger.service';
import { isPlaceUser } from '../recours/place-role';
import { parseRecoursTimerConfig } from '../recours/recours.rules';
import { isUniqueViolation, withStrictFallback } from '../recours/strict-persistence';
import { CreateAgencyDto, AgencyViewDto, UpdateAgencyDto } from './dto/agency.dto';
import {
  CompanyPublicViewDto,
  CompanyViewDto,
  CreateCompanyDto,
  GOVERNANCE_FIELDS,
  GovernanceChangeViewDto,
  UpdateCompanyDto,
  UpdateCompanyGovernanceDto,
} from './dto/company.dto';
import { Agency } from './entities/agency.entity';
import { Company, CompanyStatus } from './entities/company.entity';
import { CompanyGovernanceChange } from './entities/company-governance-change.entity';
import { Wilaya } from './entities/wilaya.entity';
import { MEMORY_AGENCIES, MEMORY_COMPANIES, MEMORY_SEED_AT, MemoryAgency } from './adherents.memory-seed';
import { algeriaFixedHolidays, ALGERIA_WEEKEND_DAYS, ConventionParams, ELIGIBILITY_MOTIF_CATALOG } from './referential-reference-data';
import { WilayaSeed } from './wilayas.data';
import { CalendarHolidayView, ConventionReferentialService, OppositionMotifView } from './convention-referential.service';
import { IrsamReference, PlaceMetricsReferentialService, PopulationReference } from './place-metrics-referential.service';
import { IrsamIndicator } from './place-referential.data';
import { BaremeReferentialService } from './bareme-referential.service';
import { PublishedBaremeCase, PublishedVehicleCategory } from './bareme-rules';

function maskKey(hash?: string): string {
  if (!hash) return 'absente';
  return `sk_live_•••••${hash.slice(-4)}`;
}

const EMPTY_AGENCY_COUNTS: Record<'DG' | 'DR' | 'AG', number> = { DG: 0, DR: 0, AG: 0 };

/** Profil d'une compagnie modifiable par son correspondant (SEC-04) — affectation champ par champ, jamais `assign(dto)`. */
const PROFILE_FIELDS = ['name', 'nameAr', 'color', 'correspondentName', 'correspondentPhone', 'correspondentEmail'] as const;
const AGENCY_FIELDS = ['name', 'type', 'manager', 'phone', 'email', 'address', 'status'] as const;

function toCompanyView(c: Company, agencyCounts: Record<'DG' | 'DR' | 'AG', number> = EMPTY_AGENCY_COUNTS): CompanyViewDto {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    nameAr: c.nameAr,
    color: c.color,
    kind: c.kind,
    feedMode: c.feedMode,
    status: c.status,
    apiKeyMasked: maskKey(c.apiKeyHash),
    delayOverrides: c.delayOverrides,
    createdAt: c.createdAt.toISOString(),
    correspondentName: c.correspondentName,
    correspondentPhone: c.correspondentPhone,
    correspondentEmail: c.correspondentEmail,
    agencyCounts,
  };
}

/** SEC-26 : projection publique d'une compagnie concurrente. */
function toPublicView(c: CompanyViewDto): CompanyPublicViewDto {
  return { id: c.id, code: c.code, name: c.name, nameAr: c.nameAr, color: c.color, kind: c.kind, status: c.status };
}

function toAgencyView(a: Agency): AgencyViewDto {
  return {
    id: a.id,
    companyId: a.company.id,
    code: a.code,
    name: a.name,
    type: a.type,
    parentId: a.parent?.id,
    wilayaCode: a.wilaya?.code,
    manager: a.manager,
    phone: a.phone,
    email: a.email,
    address: a.address,
    status: a.status,
  };
}

function governanceView(e: CompanyGovernanceChange): GovernanceChangeViewDto {
  return {
    id: e.id,
    companyId: e.companyId,
    companyCode: e.companyCode,
    patch: e.patch,
    reason: e.reason,
    status: e.status,
    requestedById: e.requestedById,
    requestedBy: e.requestedBy,
    requestedAt: e.requestedAt.toISOString(),
    decidedById: e.decidedById,
    decidedBy: e.decidedBy,
    decidedAt: e.decidedAt?.toISOString(),
  };
}

const AGENCY_NOT_FOUND = () => new NotFoundException({ code: 'NOT_FOUND', message: 'Agence introuvable.' });

@Injectable()
export class AdherentsService {
  /** Repli mémoire — demandes de changement de gouvernance (mode dégradé, hors production). */
  private readonly memoryGovernance: GovernanceChangeViewDto[] = [];

  constructor(
    @InjectRepository(Company) private readonly companies: EntityRepository<Company>,
    @InjectRepository(Agency) private readonly agencies: EntityRepository<Agency>,
    @InjectRepository(Wilaya) private readonly wilayas: EntityRepository<Wilaya>,
    @InjectRepository(CompanyGovernanceChange) private readonly governance: EntityRepository<CompanyGovernanceChange>,
    private readonly configService: ConfigService,
    private readonly convention: ConventionReferentialService,
    private readonly metrics: PlaceMetricsReferentialService,
    private readonly bareme: BaremeReferentialService,
    // Toujours fourni par AdherentsModule (LedgerModule importé) ; optionnel pour les specs d'autres modules.
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  private async seal(type: string, ref: string, actorId: string, summary: Record<string, unknown>): Promise<void> {
    if (this.ledger) await this.ledger.append(type, ref, actorId, JSON.stringify(summary));
  }

  // ---- Paramètres de la convention / Calendrier ouvré / Barème & motifs
  // (écran 12) — additif, voir referential-reference-data.ts. -----------

  /**
   * Réutilise EXACTEMENT les mêmes variables d'env/valeurs par défaut que
   * `RecoursService`/`EligibilityModule` (jamais une seconde constante
   * dupliquée) — et désormais le même contrôle strict (SEC-48).
   */
  getConventionParams(): ConventionParams {
    const timers = parseRecoursTimerConfig((key) => this.configService.get<string>(key));
    return {
      version: DEFAULT_ELIGIBILITY_CONFIG.version,
      silenceDays: timers.silenceDays,
      oppositionDays: timers.oppositionDays,
      forclusionMonths: timers.forclusionMonths,
      maxAmountDA: Number(this.configService.get<string>('ELIGIBILITY_MAX_AMOUNT_DA') ?? DEFAULT_ELIGIBILITY_CONFIG.maxAmountDA),
    };
  }

  /** Fériés fixes de l'année précédente à l'année suivante (cockpit, jours ouvrés) — la règle vaut pour toute année. */
  getCalendar() {
    const year = new Date().getUTCFullYear();
    return { weekendDays: ALGERIA_WEEKEND_DAYS, fixedHolidays: algeriaFixedHolidays(year - 1, year + 1) };
  }

  getMotifs() {
    return ELIGIBILITY_MOTIF_CATALOG;
  }

  /** Union fériés fixes + mobiles (prévisionnels et confirmés) avec leur statut — `GET /referential/calendar?from&to`. */
  calendarHolidays(from?: string, to?: string): Promise<CalendarHolidayView[]> {
    return this.convention.calendarHolidays(from, to);
  }

  /** Dates ISO des fériés MOBILES (prévisionnels et confirmés) entre `from` et `to` inclus. */
  extraHolidays(from: string, to: string): Promise<string[]> {
    return this.convention.extraHolidays(from, to);
  }

  /** 400 si le motif d'opposition est inconnu ou interdit (décision PO §1). */
  assertOppositionMotifUsable(code: string): Promise<OppositionMotifView> {
    return this.convention.assertOppositionMotifUsable(code);
  }

  /** Populations valides de référence par wilaya pour l'année étudiée (décision PO §3). */
  populationReferences(year: number): Promise<Record<string, PopulationReference>> {
    return this.metrics.populationReferences(year);
  }

  /** Référence IRSAM : jamais de valeur tant qu'aucune référence n'est `VALIDE_UAR` (décision PO §4). */
  irsamReference(indicator: IrsamIndicator): Promise<IrsamReference> {
    return this.metrics.irsamReference(indicator);
  }

  /** Cas des versions du barème Art. 14 au statut `VALIDE_UAR` (décision PO §5). */
  publishedBaremeCases(): Promise<PublishedBaremeCase[]> {
    return this.bareme.publishedCases();
  }

  /** Catégories de véhicule au statut `VALIDE_UAR` (décision PO §5). */
  publishedVehicleCategories(): Promise<PublishedVehicleCategory[]> {
    return this.bareme.publishedCategories();
  }

  // ---- Companies -----------------------------------------------------

  /** Répartition réelle des agences par type pour une compagnie — jointure réelle sur `Agency`, jamais une valeur inventée. */
  private async agencyCountsFor(companyId: string): Promise<Record<'DG' | 'DR' | 'AG', number>> {
    const rows = await this.agencies.find({ company: companyId });
    const counts: Record<'DG' | 'DR' | 'AG', number> = { DG: 0, DR: 0, AG: 0 };
    for (const a of rows) counts[a.type]++;
    return counts;
  }

  private agencyCountsForMemory(companyId: string): Record<'DG' | 'DR' | 'AG', number> {
    const counts: Record<'DG' | 'DR' | 'AG', number> = { DG: 0, DR: 0, AG: 0 };
    for (const a of MEMORY_AGENCIES) if (a.companyId === companyId) counts[a.type]++;
    return counts;
  }

  /** SEC-26 : un rôle compagnie voit sa propre fiche complète, les autres en projection publique minimale. */
  private projectFor(view: CompanyViewDto, user?: AuthenticatedUser): CompanyViewDto | CompanyPublicViewDto {
    if (!user) return view;
    const tenant = resolveTenantFilter(user);
    return !tenant || tenant === view.code ? view : toPublicView(view);
  }

  async listCompanies(page: number, pageSize: number): Promise<PaginatedResult<CompanyViewDto>>;
  async listCompanies(page: number, pageSize: number, user: AuthenticatedUser): Promise<PaginatedResult<CompanyViewDto | CompanyPublicViewDto>>;
  async listCompanies(page: number, pageSize: number, user?: AuthenticatedUser): Promise<PaginatedResult<CompanyViewDto | CompanyPublicViewDto>> {
    const result = await withDegradedFallback(
      'AdherentsService.listCompanies',
      async () => {
        const [rows, total] = await this.companies.findAndCount({}, { limit: pageSize, offset: (page - 1) * pageSize, orderBy: { code: 'ASC' } });
        const items = await Promise.all(rows.map(async (c) => toCompanyView(c, await this.agencyCountsFor(c.id))));
        return { page, total, items } as PaginatedResult<CompanyViewDto>;
      },
      () => {
        const page_ = paginateArray(MEMORY_COMPANIES, page, pageSize);
        return {
          ...page_,
          items: page_.items.map((c) => ({ ...c, createdAt: c.createdAt ?? MEMORY_SEED_AT, agencyCounts: this.agencyCountsForMemory(c.id) }) as CompanyViewDto),
        };
      },
    );
    return { ...result, items: result.items.map((c) => this.projectFor(c, user)) };
  }

  /** Fiche complète (usage interne inter-modules et rôles place) ; un rôle compagnie passe `user` et reçoit la projection publique pour une concurrente (SEC-26). */
  async getCompany(id: string): Promise<CompanyViewDto>;
  async getCompany(id: string, user: AuthenticatedUser): Promise<CompanyViewDto | CompanyPublicViewDto>;
  async getCompany(id: string, user?: AuthenticatedUser): Promise<CompanyViewDto | CompanyPublicViewDto> {
    const view = await withDegradedFallback(
      'AdherentsService.getCompany',
      async () => {
        const c = await this.companies.findOne({ id });
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable.' });
        return toCompanyView(c, await this.agencyCountsFor(c.id));
      },
      () => {
        const c = MEMORY_COMPANIES.find((m) => m.id === id);
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable (mode dégradé).' });
        return { ...c, createdAt: c.createdAt ?? MEMORY_SEED_AT, agencyCounts: this.agencyCountsForMemory(c.id) } as CompanyViewDto;
      },
    );
    return this.projectFor(view, user);
  }

  /** Id interne d'une compagnie à partir de son CODE (celui de `AuthenticatedUser.companyId`). */
  private async companyIdByCode(code: string): Promise<string | undefined> {
    return withDegradedFallback(
      'AdherentsService.companyIdByCode',
      async () => (await this.companies.findOne({ code }))?.id,
      () => MEMORY_COMPANIES.find((c) => c.code === code)?.id,
    );
  }

  /**
   * ⚠️ Corrigé en revue Testeur, sprint 3 : `create*`/`update*` (compagnies
   * ET agences) n'avaient aucun repli mémoire (contrairement à `list*`/
   * `get*`) — 500 garanti dès que PostgreSQL était absent.
   */
  async createCompany(dto: CreateCompanyDto, user?: AuthenticatedUser): Promise<CompanyViewDto> {
    const created = await withStrictFallback(
      'AdherentsService.createCompany',
      async () => {
        const c = this.companies.create({
          code: dto.code,
          name: dto.name,
          nameAr: dto.nameAr,
          color: dto.color,
          kind: dto.kind,
          feedMode: dto.feedMode,
          status: dto.status,
          delayOverrides: dto.delayOverrides,
          correspondentName: dto.correspondentName,
          correspondentPhone: dto.correspondentPhone,
          correspondentEmail: dto.correspondentEmail,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        try {
          await this.companies.getEntityManager().persistAndFlush(c);
        } catch (err) {
          throw isUniqueViolation(err) ? new ConflictException({ code: 'CONFLICT', message: `La compagnie ${dto.code} existe déjà.` }) : err;
        }
        return toCompanyView(c);
      },
      () => {
        if (MEMORY_COMPANIES.some((c) => c.code === dto.code)) throw new ConflictException({ code: 'CONFLICT', message: `La compagnie ${dto.code} existe déjà.` });
        const view = {
          id: randomUUID(),
          code: dto.code,
          name: dto.name,
          nameAr: dto.nameAr,
          color: dto.color,
          kind: dto.kind,
          feedMode: dto.feedMode,
          apiKeyMasked: maskKey(undefined),
          // L'entité réelle défaut à ACTIF (`Company.status`) ; sans ce défaut le champ valait `undefined` en mode dégradé.
          status: dto.status ?? CompanyStatus.ACTIF,
          delayOverrides: dto.delayOverrides,
          correspondentName: dto.correspondentName,
          correspondentPhone: dto.correspondentPhone,
          correspondentEmail: dto.correspondentEmail,
        };
        const createdAt = new Date().toISOString();
        MEMORY_COMPANIES.push({ ...view, createdAt } as (typeof MEMORY_COMPANIES)[number]);
        return { ...view, createdAt, agencyCounts: EMPTY_AGENCY_COUNTS } as CompanyViewDto;
      },
    );
    await this.seal('COMPANY_ADHESION', created.code, user?.id ?? 'system', { code: created.code, status: created.status, kind: created.kind });
    return created;
  }

  /**
   * SEC-04 : seul le PROFIL est modifiable ici (affectation champ par champ) ;
   * tout champ de GOUVERNANCE (`status`, `delayOverrides`, `kind`, `feedMode`)
   * est refusé (403) — il passe par une demande de changement validée par un
   * second ADMIN_UAR (`requestGovernanceChange`/`validateGovernanceChange`).
   * Contrôle d'accès AVANT toute écriture (revue sécurité 2026-10-18).
   */
  async updateCompany(id: string, dto: UpdateCompanyDto, user: AuthenticatedUser): Promise<CompanyViewDto> {
    const governance = GOVERNANCE_FIELDS.filter((f) => (dto as Record<string, unknown>)[f] !== undefined);
    if (governance.length > 0) {
      throw new ForbiddenException({
        code: 'GOUVERNANCE_RESERVEE',
        message: `Champs de gouvernance non modifiables ici (${governance.join(', ')}) : demande de changement ADMIN_UAR, validée par un second ADMIN_UAR.`,
      });
    }
    const existing = await this.getCompany(id);
    assertCompanyAccess(user, existing.code);
    const patch: Record<string, unknown> = {};
    for (const f of PROFILE_FIELDS) if (dto[f] !== undefined) patch[f] = dto[f];
    const updated = await withStrictFallback(
      'AdherentsService.updateCompany',
      async () => {
        const c = await this.companies.findOne({ id });
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable.' });
        for (const [k, v] of Object.entries(patch)) (c as unknown as Record<string, unknown>)[k] = v;
        await this.companies.getEntityManager().flush();
        return toCompanyView(c, await this.agencyCountsFor(c.id));
      },
      () => {
        const c = MEMORY_COMPANIES.find((m) => m.id === id);
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable (mode dégradé).' });
        for (const [k, v] of Object.entries(patch)) (c as unknown as Record<string, unknown>)[k] = v;
        return { ...c, createdAt: c.createdAt ?? MEMORY_SEED_AT, agencyCounts: this.agencyCountsForMemory(c.id) } as CompanyViewDto;
      },
    );
    await this.seal('COMPANY_PROFIL', existing.code, user.id, { fields: Object.keys(patch) });
    return updated;
  }

  // ---- Gouvernance d'une compagnie (SEC-04) -----------------------------

  private assertUarAdmin(user: AuthenticatedUser): void {
    if (user.role !== 'ADMIN_UAR' || !isPlaceUser(user)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Changement de gouvernance réservé à l’Admin UAR.' });
    }
  }

  private async listGovernanceRaw(companyId: string): Promise<GovernanceChangeViewDto[]> {
    return withDegradedFallback(
      'AdherentsService.listGovernanceChanges',
      async () => (await this.governance.find({ companyId }, { orderBy: { requestedAt: 'DESC' } })).map(governanceView),
      () => this.memoryGovernance.filter((g) => g.companyId === companyId).sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1)),
    );
  }

  async listGovernanceChanges(companyId: string, user: AuthenticatedUser): Promise<GovernanceChangeViewDto[]> {
    if (!isPlaceUser(user)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Réservé aux rôles de la place.' });
    await this.getCompany(companyId);
    return this.listGovernanceRaw(companyId);
  }

  async requestGovernanceChange(companyId: string, dto: UpdateCompanyGovernanceDto, user: AuthenticatedUser): Promise<GovernanceChangeViewDto> {
    this.assertUarAdmin(user);
    const company = await this.getCompany(companyId);
    const patch: Record<string, unknown> = {};
    for (const f of GOVERNANCE_FIELDS) if (dto[f] !== undefined) patch[f] = dto[f];
    if (Object.keys(patch).length === 0) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Aucun champ de gouvernance à modifier.' });
    const record = { companyId, companyCode: company.code, patch, reason: dto.reason.trim(), status: 'EN_ATTENTE', requestedById: user.id, requestedBy: user.name };
    const view = await withStrictFallback(
      'AdherentsService.requestGovernanceChange',
      async () => {
        const e = this.governance.create({ ...record, requestedAt: new Date() } as never);
        await this.governance.getEntityManager().persistAndFlush(e);
        return governanceView(e);
      },
      () => {
        const row: GovernanceChangeViewDto = { id: randomUUID(), ...record, requestedAt: new Date().toISOString() };
        this.memoryGovernance.push(row);
        return { ...row };
      },
    );
    await this.seal('COMPANY_GOUVERNANCE_DEMANDE', company.code, user.id, { change: view.id, patch });
    return view;
  }

  /** Quatre yeux : le valideur n'est pas l'auteur de la demande ; la compagnie est mise à jour champ par champ puis l'acte scellé (auteur + valideur). */
  async decideGovernanceChange(companyId: string, changeId: string, decision: 'VALIDEE' | 'REJETEE', user: AuthenticatedUser): Promise<GovernanceChangeViewDto> {
    this.assertUarAdmin(user);
    const change = (await this.listGovernanceRaw(companyId)).find((g) => g.id === changeId);
    if (!change) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Demande de changement introuvable.' });
    if (change.status !== 'EN_ATTENTE') throw new ConflictException({ code: 'CONFLICT', message: `Demande déjà ${change.status === 'VALIDEE' ? 'validée' : 'rejetée'}.` });
    if (change.requestedById === user.id) {
      throw new ConflictException({ code: 'FOUR_EYES', message: 'Règle des quatre yeux : la demande doit être validée par un autre Admin UAR que son auteur.' });
    }
    const before = await this.getCompany(companyId);
    const decidedAt = new Date();
    const apply = decision === 'VALIDEE';
    const result = await withStrictFallback(
      'AdherentsService.decideGovernanceChange',
      async () =>
        (this.governance.getEntityManager() as EntityManager).fork({ clear: true }).transactional(async (tem) => {
          const g = await tem.findOne(CompanyGovernanceChange, { id: changeId, status: 'EN_ATTENTE' });
          if (!g) throw new ConflictException({ code: 'CONFLICT', message: 'Demande déjà traitée.' });
          if (apply) {
            const c = await tem.findOneOrFail(Company, { id: companyId });
            for (const [k, v] of Object.entries(change.patch)) (c as unknown as Record<string, unknown>)[k] = v;
          }
          Object.assign(g, { status: decision, decidedById: user.id, decidedBy: user.name, decidedAt });
          await tem.flush();
          await this.seal(apply ? 'COMPANY_GOUVERNANCE' : 'COMPANY_GOUVERNANCE_REJET', change.companyCode, user.id, {
            change: change.id,
            requestedBy: change.requestedById,
            validatedBy: user.id,
            before: Object.fromEntries(Object.keys(change.patch).map((k) => [k, (before as unknown as Record<string, unknown>)[k]])),
            after: apply ? change.patch : undefined,
          });
          return governanceView(g);
        }),
      async () => {
        const g = this.memoryGovernance.find((r) => r.id === changeId);
        if (!g || g.status !== 'EN_ATTENTE') throw new ConflictException({ code: 'CONFLICT', message: 'Demande déjà traitée.' });
        if (apply) {
          const c = MEMORY_COMPANIES.find((m) => m.id === companyId);
          if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable (mode dégradé).' });
          for (const [k, v] of Object.entries(change.patch)) (c as unknown as Record<string, unknown>)[k] = v;
        }
        Object.assign(g, { status: decision, decidedById: user.id, decidedBy: user.name, decidedAt: decidedAt.toISOString() });
        await this.seal(apply ? 'COMPANY_GOUVERNANCE' : 'COMPANY_GOUVERNANCE_REJET', change.companyCode, user.id, {
          change: change.id,
          requestedBy: change.requestedById,
          validatedBy: user.id,
          before: Object.fromEntries(Object.keys(change.patch).map((k) => [k, (before as unknown as Record<string, unknown>)[k]])),
          after: apply ? change.patch : undefined,
        });
        return { ...g };
      },
    );
    return result;
  }

  /**
   * Constat d'un retrait devenu effectif (Art. 30-35), appelé par
   * `MembershipService` (CommissionModule) dans SA transaction, après ses
   * propres contrôles d'autorisation. Changement de statut scellé au journal (SEC-04).
   */
  async markCompanyWithdrawn(id: string, effectiveDate: string, user?: AuthenticatedUser): Promise<CompanyViewDto> {
    const view = await withStrictFallback(
      'AdherentsService.markCompanyWithdrawn',
      async () => {
        const c = await this.companies.findOne({ id });
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable.' });
        c.status = CompanyStatus.EN_RETRAIT;
        c.withdrawalEffectiveDate = effectiveDate;
        await this.companies.getEntityManager().flush();
        return toCompanyView(c, await this.agencyCountsFor(c.id));
      },
      () => {
        const c = MEMORY_COMPANIES.find((m) => m.id === id);
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable (mode dégradé).' });
        c.status = CompanyStatus.EN_RETRAIT;
        c.withdrawalEffectiveDate = effectiveDate;
        return { ...c, createdAt: c.createdAt ?? MEMORY_SEED_AT, agencyCounts: this.agencyCountsForMemory(c.id) } as CompanyViewDto;
      },
    );
    await this.seal('COMPANY_STATUT', view.code, user?.id ?? 'system', { status: CompanyStatus.EN_RETRAIT, withdrawalEffectiveDate: effectiveDate, origine: 'retrait constaté (Art. 30-35)' });
    return view;
  }

  /**
   * Statut réel d'une compagnie par son CODE (pas son id) — utilisé par
   * `ClaimsService.openRecours` pour refuser un nouveau recours d'une
   * compagnie qui n'est plus ACTIF (audit sécurité 2026-10-19). `undefined`
   * si le code est inconnu : laissé à l'appelant plutôt que fabriqué ici.
   */
  async companyStatusByCode(code: string): Promise<{ status: CompanyStatus; withdrawalEffectiveDate?: string } | undefined> {
    return withDegradedFallback(
      'AdherentsService.companyStatusByCode',
      async () => {
        const c = await this.companies.findOne({ code });
        return c ? { status: c.status, withdrawalEffectiveDate: c.withdrawalEffectiveDate } : undefined;
      },
      () => {
        const c = MEMORY_COMPANIES.find((m) => m.code === code);
        return c ? { status: c.status, withdrawalEffectiveDate: c.withdrawalEffectiveDate } : undefined;
      },
    );
  }

  /**
   * `undefined` si `code` est ACTIF ou inconnu du référentiel, sinon le motif
   * de refus — pour un appelant qui doit TAGUER plutôt que lever. `eventDate` :
   * date du sinistre (exception EN_RETRAIT, Chapitre VI Art. 30-35).
   */
  async companyInactiveReason(code: string, eventDate: string | undefined): Promise<string | undefined> {
    const company = await this.companyStatusByCode(code);
    if (!company || company.status === 'ACTIF') return undefined;
    const antérieurAuRetrait = company.status === 'EN_RETRAIT' && !!company.withdrawalEffectiveDate && !!eventDate && eventDate < company.withdrawalEffectiveDate;
    if (antérieurAuRetrait) return undefined;
    return `${code} n'est plus une compagnie active (statut ${company.status}).`;
  }

  /** Lève `COMPAGNIE_NON_ACTIVE` (403) — voir `companyInactiveReason` pour les règles. */
  async assertCompanyActiveFor(code: string, eventDate: string | undefined): Promise<void> {
    const reason = await this.companyInactiveReason(code, eventDate);
    if (reason) throw new ForbiddenException({ code: 'COMPAGNIE_NON_ACTIVE', message: reason });
  }

  // ---- Agencies --------------------------------------------------------

  /** SEC-26 : un rôle compagnie ne liste que les agences de SA compagnie, quel que soit le filtre demandé. */
  async listAgencies(page: number, pageSize: number, companyId?: string, user?: AuthenticatedUser): Promise<PaginatedResult<AgencyViewDto>> {
    const tenant = user ? resolveTenantFilter(user) : undefined;
    let effectiveCompanyId = companyId;
    if (tenant) {
      const ownId = await this.companyIdByCode(tenant);
      if (!ownId || (companyId && companyId !== ownId)) return paginateArray<AgencyViewDto>([], page, pageSize);
      effectiveCompanyId = ownId;
    }
    return withDegradedFallback(
      'AdherentsService.listAgencies',
      async () => {
        const where = effectiveCompanyId ? { company: effectiveCompanyId } : {};
        const [rows, total] = await this.agencies.findAndCount(where, {
          limit: pageSize,
          offset: (page - 1) * pageSize,
          populate: ['company', 'wilaya', 'parent'],
          orderBy: { code: 'ASC' },
        });
        return { page, total, items: rows.map(toAgencyView) } as PaginatedResult<AgencyViewDto>;
      },
      () => {
        const filtered = effectiveCompanyId ? MEMORY_AGENCIES.filter((a) => a.companyId === effectiveCompanyId) : MEMORY_AGENCIES;
        return paginateArray(filtered as unknown as AgencyViewDto[], page, pageSize);
      },
    );
  }

  /** Compagnie et parent d'une agence (base, puis repli mémoire) — pour les contrôles d'accès et de hiérarchie, hors de toute écriture. */
  private async agencyLink(id: string): Promise<{ companyId: string; companyCode: string; parentId?: string }> {
    try {
      const a = await this.agencies.findOne({ id }, { populate: ['company', 'parent'] });
      if (!a) throw AGENCY_NOT_FOUND();
      return { companyId: a.company.id, companyCode: a.company.code, parentId: a.parent?.id };
    } catch (err) {
      if ((err as { getStatus?: () => number }).getStatus?.() === 404) throw err;
      const a: MemoryAgency | undefined = MEMORY_AGENCIES.find((m) => m.id === id);
      if (!a) throw AGENCY_NOT_FOUND();
      const company = MEMORY_COMPANIES.find((c) => c.id === a.companyId);
      if (!company) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable (mode dégradé).' });
      return { companyId: company.id, companyCode: company.code, parentId: a.parentId };
    }
  }

  /**
   * SEC-31 : l'agence parente existe, appartient à la MÊME compagnie, et le
   * rattachement ne crée pas de cycle (une agence ne peut pas devenir
   * l'ancêtre d'elle-même).
   */
  private async assertValidParent(companyId: string, parentId: string, selfId?: string): Promise<void> {
    const invalid = (message: string) => new BadRequestException({ code: 'PARENT_INVALIDE', message });
    if (parentId === selfId) throw invalid('Une agence ne peut pas être sa propre parente.');
    let link: { companyId: string; parentId?: string };
    try {
      link = await this.agencyLink(parentId);
    } catch {
      throw invalid('Agence parente introuvable.');
    }
    if (link.companyId !== companyId) throw invalid('L’agence parente doit appartenir à la même compagnie.');
    const seen = new Set<string>([parentId]);
    let cursor = link.parentId;
    while (cursor) {
      if (cursor === selfId) throw invalid('Ce rattachement créerait un cycle dans la hiérarchie des agences.');
      if (seen.has(cursor)) break;
      seen.add(cursor);
      cursor = (await this.agencyLink(cursor)).parentId;
    }
  }

  /** Revue sécurité 2026-10-18 (B.7) : contrôle d'accès AVANT toute écriture. SEC-31 : parent de la même compagnie. */
  async createAgency(dto: CreateAgencyDto, user: AuthenticatedUser): Promise<AgencyViewDto> {
    const owner = await this.getCompany(dto.companyId);
    assertCompanyAccess(user, owner.code);
    if (dto.parentId) await this.assertValidParent(owner.id, dto.parentId);
    const created = await withStrictFallback(
      'AdherentsService.createAgency',
      async () => {
        const company = await this.companies.findOneOrFail({ id: dto.companyId });
        const wilaya = dto.wilayaCode ? await this.wilayas.findOne({ code: dto.wilayaCode }) : undefined;
        const parent = dto.parentId ? await this.agencies.findOne({ id: dto.parentId }) : undefined;
        const a = this.agencies.create({
          company,
          code: dto.code,
          name: dto.name,
          type: dto.type,
          wilaya: wilaya ?? undefined,
          parent: parent ?? undefined,
          manager: dto.manager,
          phone: dto.phone,
          email: dto.email,
          address: dto.address,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await this.agencies.getEntityManager().persistAndFlush(a);
        return toAgencyView(a);
      },
      () => {
        const view = {
          id: randomUUID(),
          companyId: dto.companyId,
          code: dto.code,
          name: dto.name,
          type: dto.type,
          parentId: dto.parentId,
          wilayaCode: dto.wilayaCode,
          manager: dto.manager,
          phone: dto.phone,
          email: dto.email,
          address: dto.address,
          status: CompanyStatus.ACTIF,
        };
        MEMORY_AGENCIES.push(view as MemoryAgency);
        return view as unknown as AgencyViewDto;
      },
    );
    await this.seal('AGENCE_CREEE', created.id, user.id, { company: owner.code, code: created.code, parentId: created.parentId });
    return created;
  }

  /** Affectation champ par champ (jamais `assign(dto)`) ; SEC-31 : nouveau parent de la même compagnie, sans cycle. */
  async updateAgency(id: string, dto: UpdateAgencyDto, user: AuthenticatedUser): Promise<AgencyViewDto> {
    const link = await this.agencyLink(id);
    assertCompanyAccess(user, link.companyCode);
    if (dto.parentId) await this.assertValidParent(link.companyId, dto.parentId, id);
    const updated = await withStrictFallback(
      'AdherentsService.updateAgency',
      async () => {
        const a = await this.agencies.findOneOrFail({ id }, { populate: ['company', 'wilaya', 'parent'] });
        for (const f of AGENCY_FIELDS) if (dto[f] !== undefined) (a as unknown as Record<string, unknown>)[f] = dto[f];
        if (dto.wilayaCode) a.wilaya = (await this.wilayas.findOne({ code: dto.wilayaCode })) ?? a.wilaya;
        if (dto.parentId) a.parent = (await this.agencies.findOneOrFail({ id: dto.parentId })) as Agency;
        await this.agencies.getEntityManager().flush();
        return toAgencyView(a);
      },
      () => {
        const a = MEMORY_AGENCIES.find((m) => m.id === id);
        if (!a) throw AGENCY_NOT_FOUND();
        for (const f of AGENCY_FIELDS) if (dto[f] !== undefined) (a as unknown as Record<string, unknown>)[f] = dto[f];
        if (dto.wilayaCode) a.wilayaCode = dto.wilayaCode;
        if (dto.parentId) a.parentId = dto.parentId;
        return a as unknown as AgencyViewDto;
      },
    );
    await this.seal('AGENCE_MODIFIEE', id, user.id, { company: link.companyCode, fields: Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined) });
    return updated;
  }

  // ---- Wilayas (référentiel partagé) -----------------------------------

  /** Inclut désormais `effectiveFrom`/`parentCode` (décision PO §3), champs additifs. */
  listWilayas(): Promise<WilayaSeed[]> {
    return this.metrics.listWilayas();
  }
}
