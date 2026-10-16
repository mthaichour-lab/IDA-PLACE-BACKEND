import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { CreateExpertDto, ExpertViewDto, UpdateExpertDto } from './dto/expert.dto';
import { Expert, ExpertStatus } from './entities/expert.entity';

const MEMORY_EXPERTS: ExpertViewDto[] = [
  { id: 'e-1', name: 'Karim Belkacem', firm: 'Cabinet Belkacem', agrement: 'AGR-2019-0042', wilayas: ['16', '09'], specialties: ['Carrosserie'], companies: ['CAAT', 'SAA'], status: ExpertStatus.ACTIF },
  { id: 'e-2', name: 'Yasmine Ould Ali', firm: 'Expertise Auto Est', agrement: 'AGR-2021-0117', wilayas: ['25', '19'], specialties: ['Mécanique', 'Carrosserie'], companies: ['CASH'], status: ExpertStatus.ACTIF },
];

function toView(e: Expert): ExpertViewDto {
  return { id: e.id, name: e.name, firm: e.firm, agrement: e.agrement, wilayas: e.wilayas, specialties: e.specialties, companies: e.companies, status: e.status };
}

/** ExpertsModule — B.2 : registre des experts de place. Écran 12. */
@Injectable()
export class ExpertsService {
  constructor(@InjectRepository(Expert) private readonly repo: EntityRepository<Expert>) {}

  async list(page: number, pageSize: number): Promise<PaginatedResult<ExpertViewDto>> {
    return withDegradedFallback(
      'ExpertsService.list',
      async () => {
        const [rows, total] = await this.repo.findAndCount({}, { limit: pageSize, offset: (page - 1) * pageSize, orderBy: { name: 'ASC' } });
        return { page, total, items: rows.map(toView) } as PaginatedResult<ExpertViewDto>;
      },
      () => paginateArray(MEMORY_EXPERTS, page, pageSize),
    );
  }

  async create(dto: CreateExpertDto): Promise<ExpertViewDto> {
    const e = this.repo.create({
      name: dto.name,
      firm: dto.firm,
      agrement: dto.agrement,
      wilayas: dto.wilayas ?? [],
      specialties: dto.specialties ?? [],
      companies: dto.companies ?? [],
      rib: dto.rib,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await this.repo.getEntityManager().persistAndFlush(e);
    return toView(e);
  }

  async update(id: string, dto: UpdateExpertDto): Promise<ExpertViewDto> {
    const e = await this.repo.findOne({ id });
    if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Expert introuvable.' });
    this.repo.assign(e, dto as Partial<Expert>);
    await this.repo.getEntityManager().flush();
    return toView(e);
  }
}
