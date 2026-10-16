import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { AdherentsService } from './adherents.service';
import { Company } from './entities/company.entity';
import { Agency } from './entities/agency.entity';
import { Wilaya } from './entities/wilaya.entity';

function throwingRepo() {
  return {
    findAndCount: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    findOne: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    findAll: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
  };
}

describe('AdherentsService (mode dégradé)', () => {
  let service: AdherentsService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdherentsService,
        { provide: getRepositoryToken(Company), useFactory: throwingRepo },
        { provide: getRepositoryToken(Agency), useFactory: throwingRepo },
        { provide: getRepositoryToken(Wilaya), useFactory: throwingRepo },
      ],
    }).compile();

    service = moduleRef.get(AdherentsService);
  });

  it('bascule sur le repli mémoire pour listCompanies si la base est injoignable', async () => {
    const result = await service.listCompanies(1, 6);
    expect(result.page).toBe(1);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
  });

  it('bascule sur le repli mémoire pour listWilayas (69 entrées, codes 01..69)', async () => {
    const wilayas = await service.listWilayas();
    expect(wilayas).toHaveLength(69);
    expect(wilayas[0].code).toBe('01');
    expect(wilayas[68].code).toBe('69');
  });

  it('pagine à 6 éléments par page par défaut', async () => {
    const page1 = await service.listCompanies(1, 6);
    expect(page1.items.length).toBeLessThanOrEqual(6);
  });
});
