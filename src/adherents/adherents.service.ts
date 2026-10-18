import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { DEFAULT_ELIGIBILITY_CONFIG } from '../eligibility/eligibility.rules';
import { DEFAULT_RECOURS_TIMER_CONFIG } from '../recours/recours.rules';
import { CreateAgencyDto, AgencyViewDto, UpdateAgencyDto } from './dto/agency.dto';
import { CompanyViewDto, CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';
import { Agency } from './entities/agency.entity';
import { Company } from './entities/company.entity';
import { Wilaya } from './entities/wilaya.entity';
import { MEMORY_AGENCIES, MEMORY_COMPANIES } from './adherents.memory-seed';
import { ALGERIA_FIXED_HOLIDAYS, ALGERIA_WEEKEND_DAYS, ConventionParams, ELIGIBILITY_MOTIF_CATALOG } from './referential-reference-data';
import { buildWilayaSeeds } from './wilayas.data';

function maskKey(hash?: string): string {
  if (!hash) return 'absente';
  return `sk_live_•••••${hash.slice(-4)}`;
}

const EMPTY_AGENCY_COUNTS: Record<'DG' | 'DR' | 'AG', number> = { DG: 0, DR: 0, AG: 0 };

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

@Injectable()
export class AdherentsService {
  constructor(
    @InjectRepository(Company) private readonly companies: EntityRepository<Company>,
    @InjectRepository(Agency) private readonly agencies: EntityRepository<Agency>,
    @InjectRepository(Wilaya) private readonly wilayas: EntityRepository<Wilaya>,
    private readonly configService: ConfigService,
  ) {}

  // ---- Paramètres de la convention / Calendrier ouvré / Barème & motifs
  // (écran 12) — additif, voir referential-reference-data.ts. -----------

  /**
   * Réutilise EXACTEMENT les mêmes variables d'env/valeurs par défaut que
   * `RecoursService`/`EligibilityModule` (jamais une seconde constante
   * dupliquée pour cet écran, qui risquerait de diverger silencieusement).
   */
  getConventionParams(): ConventionParams {
    return {
      version: DEFAULT_ELIGIBILITY_CONFIG.version,
      silenceDays: Number(this.configService.get<string>('RECOURS_SILENCE_DAYS') ?? DEFAULT_RECOURS_TIMER_CONFIG.silenceDays),
      oppositionDays: Number(this.configService.get<string>('RECOURS_OPPOSITION_DAYS') ?? DEFAULT_RECOURS_TIMER_CONFIG.oppositionDays),
      forclusionMonths: Number(
        this.configService.get<string>('ELIGIBILITY_RECOURS_MAX_MONTHS') ?? DEFAULT_RECOURS_TIMER_CONFIG.forclusionMonths,
      ),
      maxAmountDA: Number(this.configService.get<string>('ELIGIBILITY_MAX_AMOUNT_DA') ?? DEFAULT_ELIGIBILITY_CONFIG.maxAmountDA),
    };
  }

  getCalendar() {
    return { weekendDays: ALGERIA_WEEKEND_DAYS, fixedHolidays: ALGERIA_FIXED_HOLIDAYS };
  }

  getMotifs() {
    return ELIGIBILITY_MOTIF_CATALOG;
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

  async listCompanies(page: number, pageSize: number): Promise<PaginatedResult<CompanyViewDto>> {
    return withDegradedFallback(
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
          items: page_.items.map((c) => ({ ...c, createdAt: new Date().toISOString(), agencyCounts: this.agencyCountsForMemory(c.id) }) as CompanyViewDto),
        };
      },
    );
  }

  async getCompany(id: string): Promise<CompanyViewDto> {
    return withDegradedFallback(
      'AdherentsService.getCompany',
      async () => {
        const c = await this.companies.findOne({ id });
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable.' });
        return toCompanyView(c, await this.agencyCountsFor(c.id));
      },
      () => {
        const c = MEMORY_COMPANIES.find((m) => m.id === id);
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable (mode dégradé).' });
        return { ...c, createdAt: new Date().toISOString(), agencyCounts: this.agencyCountsForMemory(c.id) } as CompanyViewDto;
      },
    );
  }

  /**
   * ⚠️ Corrigé en revue Testeur, sprint 3 : `create*`/`update*` (compagnies
   * ET agences) n'avaient aucun repli mémoire (contrairement à `list*`/
   * `get*`) — 500 garanti dès que PostgreSQL était absent.
   */
  async createCompany(dto: CreateCompanyDto): Promise<CompanyViewDto> {
    return withDegradedFallback(
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
        await this.companies.getEntityManager().persistAndFlush(c);
        return toCompanyView(c);
      },
      () => {
        const view = {
          id: randomUUID(),
          code: dto.code,
          name: dto.name,
          nameAr: dto.nameAr,
          color: dto.color,
          kind: dto.kind,
          feedMode: dto.feedMode,
          apiKeyMasked: maskKey(undefined),
          status: dto.status,
          delayOverrides: dto.delayOverrides,
          correspondentName: dto.correspondentName,
          correspondentPhone: dto.correspondentPhone,
          correspondentEmail: dto.correspondentEmail,
        };
        MEMORY_COMPANIES.push(view as (typeof MEMORY_COMPANIES)[number]);
        return { ...view, createdAt: new Date().toISOString(), agencyCounts: EMPTY_AGENCY_COUNTS } as CompanyViewDto;
      },
    );
  }

  async updateCompany(id: string, dto: UpdateCompanyDto): Promise<CompanyViewDto> {
    return withDegradedFallback(
      'AdherentsService.updateCompany',
      async () => {
        const c = await this.companies.findOne({ id });
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable.' });
        this.companies.assign(c, dto as Partial<Company>);
        await this.companies.getEntityManager().flush();
        return toCompanyView(c, await this.agencyCountsFor(c.id));
      },
      () => {
        const c = MEMORY_COMPANIES.find((m) => m.id === id);
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable (mode dégradé).' });
        Object.assign(c, dto);
        return { ...c, createdAt: new Date().toISOString(), agencyCounts: this.agencyCountsForMemory(c.id) } as CompanyViewDto;
      },
    );
  }

  // ---- Agencies --------------------------------------------------------

  async listAgencies(page: number, pageSize: number, companyId?: string): Promise<PaginatedResult<AgencyViewDto>> {
    return withDegradedFallback(
      'AdherentsService.listAgencies',
      async () => {
        const where = companyId ? { company: companyId } : {};
        const [rows, total] = await this.agencies.findAndCount(where, {
          limit: pageSize,
          offset: (page - 1) * pageSize,
          populate: ['company', 'wilaya', 'parent'],
          orderBy: { code: 'ASC' },
        });
        return { page, total, items: rows.map(toAgencyView) } as PaginatedResult<AgencyViewDto>;
      },
      () => {
        const filtered = companyId ? MEMORY_AGENCIES.filter((a) => a.companyId === companyId) : MEMORY_AGENCIES;
        return paginateArray(filtered as unknown as AgencyViewDto[], page, pageSize);
      },
    );
  }

  async createAgency(dto: CreateAgencyDto): Promise<AgencyViewDto> {
    return withDegradedFallback(
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
          status: 'ACTIF' as const,
        };
        MEMORY_AGENCIES.push(view as unknown as (typeof MEMORY_AGENCIES)[number]);
        return view as unknown as AgencyViewDto;
      },
    );
  }

  async updateAgency(id: string, dto: UpdateAgencyDto): Promise<AgencyViewDto> {
    return withDegradedFallback(
      'AdherentsService.updateAgency',
      async () => {
        const a = await this.agencies.findOneOrFail({ id }, { populate: ['company', 'wilaya', 'parent'] });
        const wilaya = dto.wilayaCode ? await this.wilayas.findOne({ code: dto.wilayaCode }) : a.wilaya;
        this.agencies.assign(a, { ...dto, wilaya } as Partial<Agency>);
        await this.agencies.getEntityManager().flush();
        return toAgencyView(a);
      },
      () => {
        const a = MEMORY_AGENCIES.find((m) => m.id === id);
        if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Agence introuvable (mode dégradé).' });
        Object.assign(a, dto);
        return a as unknown as AgencyViewDto;
      },
    );
  }

  // ---- Wilayas (référentiel partagé) -----------------------------------

  async listWilayas(): Promise<ReturnType<typeof buildWilayaSeeds>> {
    return withDegradedFallback(
      'AdherentsService.listWilayas',
      async () => {
        const rows = await this.wilayas.findAll({ orderBy: { code: 'ASC' } });
        if (rows.length === 0) throw new Error('table wilaya vide');
        return rows.map((w) => ({ code: w.code, name: w.name, nameAr: w.nameAr, region: w.region, col: w.col, row: w.row, lat: w.lat, lng: w.lng }));
      },
      () => buildWilayaSeeds(),
    );
  }
}
