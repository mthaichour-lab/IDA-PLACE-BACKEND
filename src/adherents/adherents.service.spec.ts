import { ConfigService } from '@nestjs/config';
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
    find: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
  };
}

function fakeConfigService(overrides: Record<string, string> = {}) {
  return { get: (key: string) => overrides[key] } as unknown as ConfigService;
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
        { provide: ConfigService, useValue: fakeConfigService() },
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

  it('listCompanies (repli mémoire) renvoie agencyCounts et createdAt réels, jamais undefined (écran 12)', async () => {
    const result = await service.listCompanies(1, 6);
    const caat = result.items.find((c) => c.code === 'CAAT')!;
    expect(caat.createdAt).toBeTruthy();
    // Seed mémoire : CAAT a 1 DG (a-caat-dg) + 1 AG (a-caat-oran), 0 DR.
    expect(caat.agencyCounts).toEqual({ DG: 1, DR: 0, AG: 1 });
  });

  it('getConventionParams réutilise les mêmes valeurs par défaut que RecoursModule/EligibilityModule (jamais une constante dupliquée divergente)', () => {
    const params = service.getConventionParams();
    expect(params).toEqual({ version: 'v2025.12', silenceDays: 30, oppositionDays: 15, forclusionMonths: 6, maxAmountDA: 300_000 });
  });

  it('getCalendar renvoie le week-end légal algérien (vendredi-samedi) et des jours fériés à date fixe uniquement', () => {
    const calendar = service.getCalendar();
    expect(calendar.weekendDays).toEqual(['FRIDAY', 'SATURDAY']);
    expect(calendar.fixedHolidays.length).toBeGreaterThan(0);
    expect(calendar.fixedHolidays.every((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date))).toBe(true);
  });

  it('getMotifs renvoie le catalogue réel des motifs (pas "17 cas"/"RG-01" de la capture, non fondés)', () => {
    const motifs = service.getMotifs();
    expect(motifs.length).toBeGreaterThan(0);
    expect(motifs.every((m) => m.article.startsWith('Art.'))).toBe(true);
  });
});
