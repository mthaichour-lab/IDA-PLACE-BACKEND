import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { CreateAgencyDto, AgencyViewDto, UpdateAgencyDto } from './dto/agency.dto';
import { CompanyViewDto, CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';
import { Agency } from './entities/agency.entity';
import { Company } from './entities/company.entity';
import { Wilaya } from './entities/wilaya.entity';
import { MEMORY_AGENCIES, MEMORY_COMPANIES } from './adherents.memory-seed';
import { buildWilayaSeeds } from './wilayas.data';

function maskKey(hash?: string): string {
  if (!hash) return 'absente';
  return `sk_live_•••••${hash.slice(-4)}`;
}

function toCompanyView(c: Company): CompanyViewDto {
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
  ) {}

  // ---- Companies -----------------------------------------------------

  async listCompanies(page: number, pageSize: number): Promise<PaginatedResult<CompanyViewDto>> {
    return withDegradedFallback(
      'AdherentsService.listCompanies',
      async () => {
        const [rows, total] = await this.companies.findAndCount({}, { limit: pageSize, offset: (page - 1) * pageSize, orderBy: { code: 'ASC' } });
        return { page, total, items: rows.map(toCompanyView) } as PaginatedResult<CompanyViewDto>;
      },
      () => paginateArray(MEMORY_COMPANIES as unknown as CompanyViewDto[], page, pageSize),
    );
  }

  async getCompany(id: string): Promise<CompanyViewDto> {
    return withDegradedFallback(
      'AdherentsService.getCompany',
      async () => {
        const c = await this.companies.findOne({ id });
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable.' });
        return toCompanyView(c);
      },
      () => {
        const c = MEMORY_COMPANIES.find((m) => m.id === id);
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable (mode dégradé).' });
        return c as unknown as CompanyViewDto;
      },
    );
  }

  async createCompany(dto: CreateCompanyDto): Promise<CompanyViewDto> {
    const c = this.companies.create({
      code: dto.code,
      name: dto.name,
      nameAr: dto.nameAr,
      color: dto.color,
      kind: dto.kind,
      feedMode: dto.feedMode,
      status: dto.status,
      delayOverrides: dto.delayOverrides,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await this.companies.getEntityManager().persistAndFlush(c);
    return toCompanyView(c);
  }

  async updateCompany(id: string, dto: UpdateCompanyDto): Promise<CompanyViewDto> {
    const c = await this.companies.findOne({ id });
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable.' });
    this.companies.assign(c, dto as Partial<Company>);
    await this.companies.getEntityManager().flush();
    return toCompanyView(c);
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
  }

  async updateAgency(id: string, dto: UpdateAgencyDto): Promise<AgencyViewDto> {
    const a = await this.agencies.findOneOrFail({ id }, { populate: ['company', 'wilaya', 'parent'] });
    const wilaya = dto.wilayaCode ? await this.wilayas.findOne({ code: dto.wilayaCode }) : a.wilaya;
    this.agencies.assign(a, { ...dto, wilaya } as Partial<Agency>);
    await this.agencies.getEntityManager().flush();
    return toAgencyView(a);
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
