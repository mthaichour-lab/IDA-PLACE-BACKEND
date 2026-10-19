import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { AdherentsService } from './adherents.service';
import { Company } from './entities/company.entity';
import { Agency } from './entities/agency.entity';
import { Wilaya } from './entities/wilaya.entity';
import { ConstatCircumstance } from './entities/constat-circumstance.entity';
import { IrsamBenchmark } from './entities/irsam-benchmark.entity';
import { MobileHoliday } from './entities/mobile-holiday.entity';
import { OppositionMotif } from './entities/opposition-motif.entity';
import { WilayaPopulation } from './entities/wilaya-population.entity';
import { ConventionReferentialService } from './convention-referential.service';
import { PlaceMetricsReferentialService } from './place-metrics-referential.service';
import { BaremeReferentialService } from './bareme-referential.service';
import { BaremeCase } from './entities/bareme-case.entity';
import { BaremeVersion } from './entities/bareme-version.entity';
import { VehicleCategory } from './entities/vehicle-category.entity';

/** Acteur scopé compagnie — voir claims.service.spec.ts `correspondant()`. */
function correspondant(companyId: string): AuthenticatedUser {
  return { id: 'u', name: 'Correspondant (test)', email: 'c@test.dz', role: 'CORRESPONDANT_IDA', companyId, privileges: ['refedit'] };
}
function placeUser(): AuthenticatedUser {
  return { id: 'u2', name: 'Opérateur (test)', email: 'o@test.dz', role: 'OPERATEUR_PLACE', privileges: ['refedit'] };
}

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
        ConventionReferentialService,
        PlaceMetricsReferentialService,
        BaremeReferentialService,
        ...[MobileHoliday, ConstatCircumstance, OppositionMotif, WilayaPopulation, IrsamBenchmark, BaremeVersion, BaremeCase, VehicleCategory].map((e) => ({ provide: getRepositoryToken(e), useFactory: throwingRepo })),
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

  it('createCompany (repli mémoire) défaut status à ACTIF quand il n’est pas fourni', async () => {
    const created = await service.createCompany({ code: 'NEW1', name: 'Nouvelle Compagnie', color: '#445566', kind: 'INSURER' as never, feedMode: 'API' as never });
    expect(created.status).toBe('ACTIF');
  });

  it('createdAt (repli mémoire) est stable d’une lecture à l’autre', async () => {
    const first = (await service.listCompanies(1, 6)).items.find((c) => c.code === 'CAAT')!.createdAt;
    await new Promise((r) => setTimeout(r, 5));
    expect((await service.getCompany('c-caat')).createdAt).toBe(first);
    expect((await service.listCompanies(1, 6)).items.find((c) => c.code === 'CAAT')!.createdAt).toBe(first);
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

  describe('scoping tenant sur les mutations référentielles (B.7, revue sécurité 2026-10-18)', () => {
    it("updateCompany refuse avec un 403 qu'un CORRESPONDANT_IDA modifie une AUTRE compagnie", async () => {
      await expect(service.updateCompany('c-saa', { name: 'SAA piraté' }, correspondant('CAAT'))).rejects.toMatchObject({
        response: { code: 'FORBIDDEN' },
      });
    });

    it('updateCompany autorise un CORRESPONDANT_IDA à modifier SA PROPRE compagnie', async () => {
      const updated = await service.updateCompany('c-caat', { name: 'CAAT Assurance (MAJ)' }, correspondant('CAAT'));
      expect(updated.name).toBe('CAAT Assurance (MAJ)');
    });

    it("updateCompany autorise toujours un rôle place (OPERATEUR_PLACE) sur n'importe quelle compagnie", async () => {
      const updated = await service.updateCompany('c-saa', { name: 'SAA (MAJ place)' }, placeUser());
      expect(updated.name).toBe('SAA (MAJ place)');
    });

    it("createAgency refuse avec un 403 qu'un CORRESPONDANT_IDA crée une agence pour une AUTRE compagnie", async () => {
      await expect(
        service.createAgency({ companyId: 'c-saa', code: 'AG-X', name: 'Agence pirate', type: 'AG' as never }, correspondant('CAAT')),
      ).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
    });

    it('createAgency autorise un CORRESPONDANT_IDA à créer une agence pour SA PROPRE compagnie', async () => {
      const created = await service.createAgency({ companyId: 'c-caat', code: 'AG-NEW', name: 'Nouvelle agence CAAT', type: 'AG' as never }, correspondant('CAAT'));
      expect(created.companyId).toBe('c-caat');
    });

    it("updateAgency refuse avec un 403 qu'un CORRESPONDANT_IDA modifie une agence d'une AUTRE compagnie", async () => {
      await expect(service.updateAgency('a-saa-dg', { name: 'SAA DG piraté' }, correspondant('CAAT'))).rejects.toMatchObject({
        response: { code: 'FORBIDDEN' },
      });
    });

    it('updateAgency autorise un CORRESPONDANT_IDA à modifier une agence de SA PROPRE compagnie', async () => {
      const updated = await service.updateAgency('a-caat-dg', { name: 'CAAT DG (MAJ)' }, correspondant('CAAT'));
      expect(updated.name).toBe('CAAT DG (MAJ)');
    });
  });
});
