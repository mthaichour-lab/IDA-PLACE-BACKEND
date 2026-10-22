import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { LedgerService } from '../ledger/ledger.service';
import { MEMORY_IDS } from './adherents.memory-seed';
import { AdherentsService } from './adherents.service';
import { CompanyGovernanceChange } from './entities/company-governance-change.entity';
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
import { simulatedDatabaseOutage } from '../common/database/db-errors';

/** Acteur scopé compagnie — voir claims.service.spec.ts `correspondant()`. */
function correspondant(companyId: string): AuthenticatedUser {
  return { id: 'u', name: 'Correspondant (test)', email: 'c@test.dz', role: 'CORRESPONDANT_IDA', companyId, privileges: ['refedit'] };
}
function placeUser(): AuthenticatedUser {
  return { id: 'u2', name: 'Opérateur (test)', email: 'o@test.dz', role: 'OPERATEUR_PLACE', privileges: ['refedit'] };
}
function adminUar(id: string): AuthenticatedUser {
  return { id, name: `Admin UAR ${id}`, email: `${id}@uar.dz`, role: 'ADMIN_UAR', privileges: ['validateRef', 'refedit'] };
}

function throwingRepo() {
  const fail = () => Promise.reject(simulatedDatabaseOutage());
  const em: Record<string, jest.Mock> = { find: jest.fn(fail), findOne: jest.fn(fail), transactional: jest.fn(fail), persistAndFlush: jest.fn(fail), flush: jest.fn(fail) };
  em.fork = jest.fn(() => em);
  return {
    findAndCount: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    findOne: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    findOneOrFail: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    findAll: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    find: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    create: jest.fn((d: unknown) => d),
    getEntityManager: jest.fn(() => em),
  };
}

function fakeConfigService(overrides: Record<string, string> = {}) {
  return { get: (key: string) => overrides[key] } as unknown as ConfigService;
}

describe('AdherentsService (mode dégradé)', () => {
  let service: AdherentsService;
  let ledgerAppend: jest.Mock;
  let config: Record<string, string>;

  beforeEach(async () => {
    ledgerAppend = jest.fn(async () => ({}));
    config = {};
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
        { provide: getRepositoryToken(CompanyGovernanceChange), useFactory: throwingRepo },
        { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
        { provide: LedgerService, useValue: { append: ledgerAppend } },
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
    // Seed mémoire : CAAT a 1 DG + 1 AG, 0 DR.
    expect(caat.agencyCounts).toEqual({ DG: 1, DR: 0, AG: 1 });
  });

  it('createCompany (repli mémoire) défaut status à ACTIF quand il n’est pas fourni', async () => {
    const created = await service.createCompany({ code: 'NEW1', name: 'Nouvelle Compagnie', color: '#445566', kind: 'INSURER' as never, feedMode: 'API' as never });
    expect(created.status).toBe('ACTIF');
  });

  it('createdAt (repli mémoire) est stable d’une lecture à l’autre', async () => {
    const first = (await service.listCompanies(1, 6)).items.find((c) => c.code === 'CAAT')!.createdAt;
    await new Promise((r) => setTimeout(r, 5));
    expect((await service.getCompany(MEMORY_IDS.CAAT)).createdAt).toBe(first);
    expect((await service.listCompanies(1, 6)).items.find((c) => c.code === 'CAAT')!.createdAt).toBe(first);
  });

  it('getConventionParams réutilise les mêmes valeurs par défaut que RecoursModule/EligibilityModule (jamais une constante dupliquée divergente)', () => {
    const params = service.getConventionParams();
    expect(params).toEqual({ version: 'v2025.12', silenceDays: 30, oppositionDays: 15, forclusionMonths: 6, maxAmountDA: 300_000 });
  });

  it('SEC-48 : getConventionParams applique la même validation stricte que RecoursModule', () => {
    config.RECOURS_SILENCE_DAYS = 'abc';
    expect(() => service.getConventionParams()).toThrow(/Configuration invalide/);
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
      await expect(service.updateCompany(MEMORY_IDS.SAA, { name: 'SAA piraté' }, correspondant('CAAT'))).rejects.toMatchObject({
        response: { code: 'FORBIDDEN' },
      });
    });

    it('updateCompany autorise un CORRESPONDANT_IDA à modifier SA PROPRE compagnie', async () => {
      const updated = await service.updateCompany(MEMORY_IDS.CAAT, { name: 'CAAT Assurance (MAJ)' }, correspondant('CAAT'));
      expect(updated.name).toBe('CAAT Assurance (MAJ)');
    });

    it("updateCompany autorise toujours un rôle place (OPERATEUR_PLACE) sur n'importe quelle compagnie", async () => {
      const updated = await service.updateCompany(MEMORY_IDS.SAA, { name: 'SAA (MAJ place)' }, placeUser());
      expect(updated.name).toBe('SAA (MAJ place)');
    });

    it("createAgency refuse avec un 403 qu'un CORRESPONDANT_IDA crée une agence pour une AUTRE compagnie", async () => {
      await expect(
        service.createAgency({ companyId: MEMORY_IDS.SAA, code: 'AG-X', name: 'Agence pirate', type: 'AG' as never }, correspondant('CAAT')),
      ).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
    });

    it('createAgency autorise un CORRESPONDANT_IDA à créer une agence pour SA PROPRE compagnie', async () => {
      const created = await service.createAgency({ companyId: MEMORY_IDS.CAAT, code: 'AG-NEW', name: 'Nouvelle agence CAAT', type: 'AG' as never }, correspondant('CAAT'));
      expect(created.companyId).toBe(MEMORY_IDS.CAAT);
    });

    it("updateAgency refuse avec un 403 qu'un CORRESPONDANT_IDA modifie une agence d'une AUTRE compagnie", async () => {
      await expect(service.updateAgency(MEMORY_IDS.AGENCY_SAA_DG, { name: 'SAA DG piraté' }, correspondant('CAAT'))).rejects.toMatchObject({
        response: { code: 'FORBIDDEN' },
      });
    });

    it('updateAgency autorise un CORRESPONDANT_IDA à modifier une agence de SA PROPRE compagnie', async () => {
      const updated = await service.updateAgency(MEMORY_IDS.AGENCY_CAAT_DG, { name: 'CAAT DG (MAJ)' }, correspondant('CAAT'));
      expect(updated.name).toBe('CAAT DG (MAJ)');
    });
  });
  describe('SEC-04 — gouvernance d’une compagnie (statut, délais, nature, alimentation)', () => {
    it('un CORRESPONDANT_IDA ne peut pas modifier le statut ni les délais de SA compagnie (403 GOUVERNANCE_RESERVEE), la compagnie est inchangée', async () => {
      for (const patch of [{ status: 'ACTIF' }, { delayOverrides: { recoursDays: 365 } }, { kind: 'MUTUAL' }, { feedMode: 'API' }]) {
        await expect(service.updateCompany(MEMORY_IDS.CAAT, patch as never, correspondant('CAAT'))).rejects.toMatchObject({ status: 403, response: { code: 'GOUVERNANCE_RESERVEE' } });
      }
      expect((await service.getCompany(MEMORY_IDS.CAAT)).status).toBe('ACTIF');
    });

    it('une compagnie SUSPENDU ne peut pas se remettre ACTIF elle-même (403)', async () => {
      await expect(service.updateCompany(MEMORY_IDS.TALA, { status: 'ACTIF' } as never, correspondant('TALA'))).rejects.toMatchObject({ status: 403 });
      expect((await service.getCompany(MEMORY_IDS.TALA)).status).toBe('SUSPENDU');
    });

    it('même un rôle place passe par une demande à quatre yeux (403 sur PUT)', async () => {
      await expect(service.updateCompany(MEMORY_IDS.SAA, { status: 'EXCLU' } as never, placeUser())).rejects.toMatchObject({ status: 403 });
    });

    it('demande par un Admin UAR, sans effet avant validation ; validation par un SECOND Admin UAR, scellée avec auteur et valideur', async () => {
      const company = await service.createCompany({ code: 'GOV1', name: 'Gouvernance', color: '#445566', kind: 'INSURER' as never, feedMode: 'API' as never });
      await expect(service.requestGovernanceChange(company.id, { status: 'SUSPENDU' as never, reason: 'x' }, placeUser())).rejects.toMatchObject({ status: 403 });

      const change = await service.requestGovernanceChange(company.id, { status: 'SUSPENDU' as never, delayOverrides: { recoursDays: 45 }, reason: 'Décision de commission n° 12' }, adminUar('uar-a'));
      expect(change).toMatchObject({ status: 'EN_ATTENTE', requestedById: 'uar-a', patch: { status: 'SUSPENDU', delayOverrides: { recoursDays: 45 } } });
      expect((await service.getCompany(company.id)).status).toBe('ACTIF');

      await expect(service.decideGovernanceChange(company.id, change.id, 'VALIDEE', adminUar('uar-a'))).rejects.toMatchObject({ status: 409, response: { code: 'FOUR_EYES' } });
      const validated = await service.decideGovernanceChange(company.id, change.id, 'VALIDEE', adminUar('uar-b'));
      expect(validated).toMatchObject({ status: 'VALIDEE', decidedById: 'uar-b' });
      expect(await service.getCompany(company.id)).toMatchObject({ status: 'SUSPENDU', delayOverrides: { recoursDays: 45 } });
      expect(ledgerAppend).toHaveBeenCalledWith('COMPANY_GOUVERNANCE', 'GOV1', 'uar-b', expect.stringMatching(/"requestedBy":"uar-a".*"validatedBy":"uar-b"/));

      await expect(service.decideGovernanceChange(company.id, change.id, 'VALIDEE', adminUar('uar-c'))).rejects.toMatchObject({ status: 409 });
    });

    it('un rejet laisse la compagnie inchangée', async () => {
      const company = await service.createCompany({ code: 'GOV2', name: 'Gouvernance 2', color: '#445566', kind: 'INSURER' as never, feedMode: 'API' as never });
      const change = await service.requestGovernanceChange(company.id, { status: 'EXCLU' as never, reason: 'x' }, adminUar('uar-a'));
      await service.decideGovernanceChange(company.id, change.id, 'REJETEE', adminUar('uar-b'));
      expect((await service.getCompany(company.id)).status).toBe('ACTIF');
    });
  });

  describe('SEC-26 — minimisation du référentiel pour les rôles compagnie', () => {
    it('listCompanies : fiche complète de SA compagnie, projection publique des concurrentes', async () => {
      const result = await service.listCompanies(1, 50, correspondant('CAAT'));
      const caat = result.items.find((c) => c.code === 'CAAT')!;
      const saa = result.items.find((c) => c.code === 'SAA')!;
      expect(caat).toHaveProperty('agencyCounts');
      expect(saa).toMatchObject({ code: 'SAA', name: expect.any(String), color: expect.any(String), status: expect.any(String) });
      expect(saa).not.toHaveProperty('agencyCounts');
      expect(saa).not.toHaveProperty('correspondentName');
      expect(saa).not.toHaveProperty('delayOverrides');
      expect(saa).not.toHaveProperty('apiKeyMasked');
    });

    it('getCompany : projection publique pour une concurrente, complète pour un rôle place', async () => {
      expect(await service.getCompany(MEMORY_IDS.SAA, correspondant('CAAT'))).not.toHaveProperty('agencyCounts');
      expect(await service.getCompany(MEMORY_IDS.SAA, placeUser())).toHaveProperty('agencyCounts');
    });

    it('listAgencies : un rôle compagnie ne voit que SES agences, même en filtrant sur une concurrente', async () => {
      const own = await service.listAgencies(1, 50, undefined, correspondant('CAAT'));
      expect(own.items.length).toBeGreaterThan(0);
      expect(own.items.every((a) => a.companyId === MEMORY_IDS.CAAT)).toBe(true);
      expect((await service.listAgencies(1, 50, MEMORY_IDS.SAA, correspondant('CAAT'))).items).toHaveLength(0);
      expect((await service.listAgencies(1, 50, MEMORY_IDS.SAA, placeUser())).items.length).toBeGreaterThan(0);
    });
  });

  describe('Organisation d’une compagnie — DG > DR > AG', () => {
    it('une DR relève de la DG, une agence d’une DR (ou de la DG)', async () => {
      const dr = await service.createAgency({ companyId: MEMORY_IDS.CAAT, code: 'DR-OUEST', name: 'Direction régionale Ouest', type: 'DR' as never, parentId: MEMORY_IDS.AGENCY_CAAT_DG }, correspondant('CAAT'));
      const ag = await service.createAgency({ companyId: MEMORY_IDS.CAAT, code: 'AG-31-02', name: 'CAAT Es Senia', type: 'AG' as never, parentId: dr.id }, correspondant('CAAT'));
      expect(ag.parentId).toBe(dr.id);
    });

    it('refuse une DR rattachée à une agence et une DG rattachée à quoi que ce soit (400 ORGANISATION_INVALIDE)', async () => {
      await expect(
        service.createAgency({ companyId: MEMORY_IDS.CAAT, code: 'DR-X', name: 'DR', type: 'DR' as never, parentId: MEMORY_IDS.AGENCY_CAAT_ORAN }, correspondant('CAAT')),
      ).rejects.toMatchObject({ status: 400, response: { code: 'ORGANISATION_INVALIDE' } });
    });

    it('une compagnie n’a qu’une Direction générale (409 DG_EXISTANTE)', async () => {
      await expect(service.createAgency({ companyId: MEMORY_IDS.CAAT, code: 'DG-02', name: 'Seconde DG', type: 'DG' as never }, correspondant('CAAT'))).rejects.toMatchObject({
        status: 409,
        response: { code: 'DG_EXISTANTE' },
      });
    });

    it('refuse un changement de niveau qui laisserait des entités rattachées incompatibles', async () => {
      // La DG CAAT a des agences rattachées : la rétrograder en agence les laisserait sous une agence.
      await expect(service.updateAgency(MEMORY_IDS.AGENCY_CAAT_DG, { type: 'AG' as never }, correspondant('CAAT'))).rejects.toMatchObject({
        status: 400,
        response: { code: 'ORGANISATION_INVALIDE' },
      });
    });
  });

  describe('SEC-31 — rattachement hiérarchique des agences', () => {
    it('refuse (400 PARENT_INVALIDE) un parent appartenant à une autre compagnie', async () => {
      await expect(
        service.createAgency({ companyId: MEMORY_IDS.CAAT, code: 'AG-P1', name: 'Agence', type: 'AG' as never, parentId: MEMORY_IDS.AGENCY_SAA_DG }, correspondant('CAAT')),
      ).rejects.toMatchObject({ status: 400, response: { code: 'PARENT_INVALIDE' } });
      await expect(service.updateAgency(MEMORY_IDS.AGENCY_CAAT_ORAN, { parentId: MEMORY_IDS.AGENCY_SAA_DG }, correspondant('CAAT'))).rejects.toMatchObject({ status: 400 });
    });

    it('refuse un parent inexistant et un cycle', async () => {
      await expect(
        service.createAgency({ companyId: MEMORY_IDS.CAAT, code: 'AG-P2', name: 'Agence', type: 'AG' as never, parentId: '00000000-0000-4000-8000-000000000000' }, correspondant('CAAT')),
      ).rejects.toMatchObject({ status: 400 });
      // CAAT Oran a pour parent la DG CAAT : rattacher la DG à Oran créerait un cycle.
      await expect(service.updateAgency(MEMORY_IDS.AGENCY_CAAT_DG, { parentId: MEMORY_IDS.AGENCY_CAAT_ORAN }, correspondant('CAAT'))).rejects.toMatchObject({ status: 400, response: { code: 'PARENT_INVALIDE' } });
      await expect(service.updateAgency(MEMORY_IDS.AGENCY_CAAT_DG, { parentId: MEMORY_IDS.AGENCY_CAAT_DG }, correspondant('CAAT'))).rejects.toMatchObject({ status: 400 });
    });

    it('accepte un parent de la même compagnie', async () => {
      const created = await service.createAgency({ companyId: MEMORY_IDS.CAAT, code: 'AG-P3', name: 'Agence', type: 'AG' as never, parentId: MEMORY_IDS.AGENCY_CAAT_DG }, correspondant('CAAT'));
      expect(created.parentId).toBe(MEMORY_IDS.AGENCY_CAAT_DG);
    });
  });
});
