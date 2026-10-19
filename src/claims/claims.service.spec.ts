import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AdherentsService } from '../adherents/adherents.service';
import { BaremeReferentialService } from '../adherents/bareme-referential.service';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { EligibilityService } from '../eligibility/eligibility.service';
import { MatchQueueItem } from '../matching/entities/match-queue-item.entity';
import { MatchingService } from '../matching/matching.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import { RecoursService } from '../recours/recours.service';
import { CLAIM_IMPORT_COLUMNS } from './claim-47-columns';
import { CLAIM_IMPORT_EXTENSION_COLUMNS } from './claim-extension-columns';
import { ClaimsService } from './claims.service';
import { Claim } from './entities/claim.entity';

/** Repli mémoire forcé : toute opération dépendant de la base échoue (voir adherents.service.spec.ts). */
function throwingRepo() {
  return {
    create: jest.fn((data: unknown) => data),
    findAndCount: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    findOne: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    findAll: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    getEntityManager: jest.fn(() => ({
      persist: jest.fn(),
      persistAndFlush: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
      flush: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    })),
  };
}

/** Référentiel barème en repli mémoire : toute opération base échoue. */
function failingRepo() {
  const fail = jest.fn().mockRejectedValue(new Error('DB injoignable (test)'));
  return {
    findAll: fail,
    find: fail,
    findOne: fail,
    findOneOrFail: fail,
    create: jest.fn((d: unknown) => d),
    assign: jest.fn(),
    getEntityManager: jest.fn(() => ({ persist: jest.fn(), persistAndFlush: fail, flush: fail, removeAndFlush: fail })),
  } as never;
}

function fakeConfigService() {
  return { get: () => undefined } as unknown as ConfigService;
}

/** Construit une ligne de valeurs CSV (dans l'ordre exact de CLAIM_IMPORT_COLUMNS). */
function buildCsvRow(overrides: Record<string, string>): string {
  return CLAIM_IMPORT_COLUMNS.map((c) => overrides[c.key] ?? '').join(',');
}

const header = CLAIM_IMPORT_COLUMNS.map((c) => c.label).join(',');

const BASE_ROW: Record<string, string> = {
  dateAccident: '2026-01-10',
  heureAccident: '10:00',
  wilaya: '16',
  commune: 'Alger-Centre',
  nombreVehicules: '2',
  territoire: 'ALGERIE',
  dommagesCorporelsDeclares: 'non',
  adversePartieAdherente: 'oui',
  adversePartieActive: 'oui',
  montantEstime: '150000',
  montantExpertise: '140000',
  dateDemandeRecours: '2026-01-20',
  piecesFournies: 'CONSTAT_AMIABLE;CARTE_GRISE;PERMIS_CONDUIRE;ATTESTATION_ASSURANCE',
  constatAmiableSigneDeuxParties: 'oui',
  canalDeclaration: 'IMPORT',
};

describe('ClaimsService (mode dégradé — import, éligibilité, appariement)', () => {
  let service: ClaimsService;
  let matchingService: MatchingService;
  let emitEvent: jest.Mock;
  let bareme: BaremeReferentialService;
  let recoursRows: Array<{ claimId: string }>;
  let recoursCreate: jest.Mock;
  let companyStatusByCode: jest.Mock;

  beforeEach(async () => {
    emitEvent = jest.fn();
    bareme = new BaremeReferentialService(failingRepo(), failingRepo(), failingRepo());
    recoursRows = [];
    recoursCreate = jest.fn(async (dto: { claimId: string }) => ({ id: 'r-1', ...dto }));
    companyStatusByCode = jest.fn(async () => undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ClaimsService,
        EligibilityService,
        MatchingService,
        { provide: getRepositoryToken(Claim), useFactory: throwingRepo },
        { provide: getRepositoryToken(MatchQueueItem), useFactory: throwingRepo },
        { provide: ConfigService, useFactory: fakeConfigService },
        { provide: RealtimeGateway, useValue: { emitEvent } },
        { provide: RecoursService, useValue: { listAll: jest.fn(async () => recoursRows), create: recoursCreate } },
        {
          provide: AdherentsService,
          useValue: {
            publishedBaremeCases: () => bareme.publishedCases(),
            publishedVehicleCategories: () => bareme.publishedCategories(),
            companyStatusByCode,
          },
        },
      ],
    }).compile();

    service = moduleRef.get(ClaimsService);
    matchingService = moduleRef.get(MatchingService);
  });

  it('importe un fichier CSV valide : rapport ELIGIBLE_IDA, persistance en mode dégradé, événement claim.ingested', async () => {
    const row = buildCsvRow({
      ...BASE_ROW,
      numEconstat: 'ECT-2026-100',
      compagnieA: 'CAAT',
      compagnieB: 'SAA',
      immatriculationA: '16-100000-16',
      immatriculationB: '31-200000-31',
    });
    const buffer = Buffer.from(`${header}\n${row}\n`, 'utf-8');

    const report = await service.importFile('import.csv', buffer);

    expect(report.fileName).toBe('import.csv');
    expect(report.totalRows).toBe(1);
    expect(report.eligibleCount).toBe(1);
    expect(report.ineligibleCount).toBe(0);
    expect(report.rows[0].verdict).toBe('ELIGIBLE_IDA');
    expect(report.rows[0].reasons).toHaveLength(0);
    expect(report.rows[0].data.numEconstat).toBe('ECT-2026-100');

    // Persisté (repli mémoire) et visible via list().
    const list = await service.list({ page: 1, pageSize: 6 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0].company).toBe('CAAT');
    expect(list.items[0].state).toBe('A_APPARIER');

    // Événement temps réel émis après import (B.12).
    expect(emitEvent).toHaveBeenCalledWith('claim.ingested', expect.objectContaining({ fileName: 'import.csv', eligibleCount: 1 }));
  });

  it('marque HORS_IDA un dossier à 1 véhicule et conserve le motif Art. 4', async () => {
    const row = buildCsvRow({ ...BASE_ROW, compagnieA: 'CAAT', compagnieB: 'SAA', nombreVehicules: '1' });
    const buffer = Buffer.from(`${header}\n${row}\n`, 'utf-8');

    const report = await service.importFile('import.csv', buffer);

    expect(report.rows[0].verdict).toBe('HORS_IDA');
    expect(report.rows[0].reasons.some((r) => r.includes('Art. 4'))).toBe(true);

    const list = await service.list({ page: 1, pageSize: 6 });
    expect(list.items[0].state).toBe('HORS_IDA');
  });

  it('marque HORS_IDA une ligne avec erreur de format (montant non numérique), sans planter l’import', async () => {
    const row = buildCsvRow({ ...BASE_ROW, compagnieA: 'CAAT', compagnieB: 'SAA', montantEstime: 'abc', montantExpertise: 'abc' });
    const buffer = Buffer.from(`${header}\n${row}\n`, 'utf-8');

    const report = await service.importFile('import.csv', buffer);

    expect(report.rows[0].verdict).toBe('HORS_IDA');
    expect(report.rows[0].reasons.some((r) => r.startsWith('Erreur de format'))).toBe(true);
  });

  it('déclenche un appariement automatique (clé exacte e-constat) entre deux déclarations du même import', async () => {
    const rowA = buildCsvRow({
      ...BASE_ROW,
      numEconstat: 'ECT-2026-200',
      compagnieA: 'CAAT',
      compagnieB: 'SAA',
      immatriculationA: '16-100000-16',
      immatriculationB: '31-200000-31',
    });
    const rowB = buildCsvRow({
      ...BASE_ROW,
      numEconstat: 'ECT-2026-200',
      compagnieA: 'SAA',
      compagnieB: 'CAAT',
      immatriculationA: '31-200000-31',
      immatriculationB: '16-100000-16',
    });
    const buffer = Buffer.from(`${header}\n${rowA}\n${rowB}\n`, 'utf-8');

    await service.importFile('import.csv', buffer);

    const queue = await matchingService.queue({ filter: 'TOUS', page: 1, pageSize: 6 });
    expect(queue.items.length).toBeGreaterThanOrEqual(2);
    const matched = queue.items.filter((i) => i.score === 100 && i.econstatShared);
    expect(matched.length).toBeGreaterThanOrEqual(1);
    expect(matched[0].level).toBe('AUTO');
    expect(matched[0].status).toBe('AUTO_CONFIRME');
  });

  describe('openRecours — statut compagnie (audit sécurité 2026-10-19)', () => {
    const operateur: AuthenticatedUser = { id: 'op-1', name: 'Opérateur', email: 'op@test.dz', role: 'OPERATEUR_PLACE', privileges: ['insert'] };

    async function importOne(numEconstat: string, accidentDate = '2026-01-10'): Promise<string> {
      const row = buildCsvRow({ ...BASE_ROW, numEconstat, compagnieA: 'CAAT', compagnieB: 'SAA', dateAccident: accidentDate });
      await service.importFile('import.csv', Buffer.from(`${header}\n${row}\n`, 'utf-8'));
      const list = await service.list({ page: 1, pageSize: 6 });
      return list.items.find((c) => c.numEconstat === numEconstat)!.id;
    }

    it('autorise un nouveau recours quand la compagnie est ACTIF (ou inconnue du référentiel appelé)', async () => {
      companyStatusByCode.mockResolvedValue({ status: 'ACTIF' });
      const claimId = await importOne('ECT-STATUS-ACTIF');
      await expect(service.openRecours({ claimId, from: 'CAAT', to: 'SAA', amount: 1000 }, operateur)).resolves.toMatchObject({ id: 'r-1' });
    });

    it('refuse (403 COMPAGNIE_NON_ACTIVE) un nouveau recours pour une compagnie EXCLU, même pour un sinistre encore dans le délai', async () => {
      companyStatusByCode.mockResolvedValue({ status: 'EXCLU' });
      const claimId = await importOne('ECT-STATUS-EXCLU');
      await expect(service.openRecours({ claimId, from: 'CAAT', to: 'SAA', amount: 1000 }, operateur)).rejects.toMatchObject({
        response: { code: 'COMPAGNIE_NON_ACTIVE' },
      });
      expect(recoursCreate).not.toHaveBeenCalled();
    });

    it('refuse (403) un nouveau recours pour une compagnie SUSPENDU', async () => {
      companyStatusByCode.mockResolvedValue({ status: 'SUSPENDU' });
      const claimId = await importOne('ECT-STATUS-SUSPENDU');
      await expect(service.openRecours({ claimId, from: 'CAAT', to: 'SAA', amount: 1000 }, operateur)).rejects.toMatchObject({
        response: { code: 'COMPAGNIE_NON_ACTIVE' },
      });
    });

    it('EN_RETRAIT : refuse un recours pour un sinistre postérieur à la date d’effet du retrait', async () => {
      companyStatusByCode.mockResolvedValue({ status: 'EN_RETRAIT', withdrawalEffectiveDate: '2026-06-30' });
      const claimId = await importOne('ECT-STATUS-RETRAIT-APRES', '2026-09-01');
      await expect(service.openRecours({ claimId, from: 'CAAT', to: 'SAA', amount: 1000 }, operateur)).rejects.toMatchObject({
        response: { code: 'COMPAGNIE_NON_ACTIVE' },
      });
    });

    it('EN_RETRAIT : autorise un recours pour un sinistre antérieur à la date d’effet du retrait (obligations maintenues, Art. 30-35)', async () => {
      companyStatusByCode.mockResolvedValue({ status: 'EN_RETRAIT', withdrawalEffectiveDate: '2026-06-30' });
      const claimId = await importOne('ECT-STATUS-RETRAIT-AVANT', '2026-03-01');
      await expect(service.openRecours({ claimId, from: 'CAAT', to: 'SAA', amount: 1000 }, operateur)).resolves.toMatchObject({ id: 'r-1' });
    });
  });

  describe('scoping tenant (B.7, §5 de la mission)', () => {
    function correspondant(companyId: string): AuthenticatedUser {
      return { id: 'u', name: 'Correspondant (test)', email: 'c@test.dz', role: 'CORRESPONDANT_IDA', companyId, privileges: [] };
    }
    function auditeur(): AuthenticatedUser {
      return { id: 'u2', name: 'Auditeur (test)', email: 'a@test.dz', role: 'AUDITEUR_CSA', privileges: [] };
    }

    it('un CORRESPONDANT_IDA ne voit que les dossiers où sa compagnie est émettrice ou adverse déclarée', async () => {
      const row = buildCsvRow({ ...BASE_ROW, compagnieA: 'XXAA', compagnieB: 'YYBB', numEconstat: 'ECT-SCOPE-1' });
      const buffer = Buffer.from(`${header}\n${row}\n`, 'utf-8');
      await service.importFile('import.csv', buffer);

      const asXXAA = await service.list({ page: 1, pageSize: 100 }, correspondant('XXAA'));
      expect(asXXAA.items.some((c) => c.numEconstat === 'ECT-SCOPE-1')).toBe(true);

      const asYYBB = await service.list({ page: 1, pageSize: 100 }, correspondant('YYBB'));
      expect(asYYBB.items.some((c) => c.numEconstat === 'ECT-SCOPE-1')).toBe(true); // partie adverse déclarée : visibilité aussi

      const asOther = await service.list({ page: 1, pageSize: 100 }, correspondant('ZZCC'));
      expect(asOther.items.some((c) => c.numEconstat === 'ECT-SCOPE-1')).toBe(false);
    });

    it('un AUDITEUR_CSA (rôle "place") voit tous les dossiers sans filtrage tenant', async () => {
      const all = await service.list({ page: 1, pageSize: 100 }, auditeur());
      expect(all.items.some((c) => c.numEconstat === 'ECT-SCOPE-1')).toBe(true);
    });

    it("get() lève un 403 pour un CORRESPONDANT_IDA hors périmètre de la compagnie", async () => {
      const row = buildCsvRow({ ...BASE_ROW, compagnieA: 'XXAA', compagnieB: 'YYBB', numEconstat: 'ECT-SCOPE-2' });
      const buffer = Buffer.from(`${header}\n${row}\n`, 'utf-8');
      await service.importFile('import.csv', buffer);
      const list = await service.list({ page: 1, pageSize: 100 }, correspondant('XXAA'));
      const claim = list.items.find((c) => c.numEconstat === 'ECT-SCOPE-2')!;

      await expect(service.get(claim.id, correspondant('ZZCC'))).rejects.toThrow(ForbiddenException);
      await expect(service.get(claim.id, correspondant('XXAA'))).resolves.toBeDefined();
    });
  });

  describe('barème Art. 14 (décision PO §5)', () => {
    const operateur: AuthenticatedUser = { id: 'op-1', name: 'Opérateur', email: 'op@test.dz', role: 'OPERATEUR_PLACE', privileges: ['params', 'matchDecide'] };
    const adminUar: AuthenticatedUser = { id: 'uar-1', name: 'Admin UAR', email: 'uar@test.dz', role: 'ADMIN_UAR', privileges: ['validateRef', 'matchDecide'] };
    function correspondant(companyId: string): AuthenticatedUser {
      return { id: `c-${companyId}`, name: 'Correspondant', email: 'c@test.dz', role: 'CORRESPONDANT_IDA', companyId, privileges: ['insert', 'matchDecide', 'import'] };
    }

    /** Ligne au modèle v2 : 47 colonnes puis les colonnes 48-53. */
    function buildV2Row(overrides: Record<string, string>, extension: Record<string, string>): string {
      return [buildCsvRow(overrides), ...CLAIM_IMPORT_EXTENSION_COLUMNS.map((c) => extension[c.key] ?? '')].join(',');
    }
    const headerV2 = [header, ...CLAIM_IMPORT_EXTENSION_COLUMNS.map((c) => c.label)].join(',');

    async function publish(): Promise<string> {
      const version = await bareme.createVersion({ label: 'Barème test' }, operateur);
      await bareme.addCase(version.id, { code: 'B01', label: 'Cas 1', partA: 100, partB: 0 }, operateur);
      await bareme.addCase(version.id, { code: 'B02', label: 'Cas 2', partA: 50, partB: 50 }, operateur);
      await bareme.validateVersion(version.id, adminUar);
      await bareme.createCategory({ code: 'VL', label: 'Véhicule léger' }, operateur);
      await bareme.validateCategory('VL', adminUar);
      return version.id;
    }

    async function importOne(numEconstat: string, company = 'CAAT', counterparty = 'SAA', extension: Record<string, string> = {}) {
      const row = buildV2Row({ ...BASE_ROW, numEconstat, compagnieA: company, compagnieB: counterparty, responsabiliteDeclareeA: '100', responsabiliteDeclareeB: '0' }, extension);
      const report = await service.importFile('v2.csv', Buffer.from(`${headerV2}\n${row}\n`, 'utf-8'));
      const claim = (await service.list({ page: 1, pageSize: 1000 })).items.find((c) => c.numEconstat === numEconstat)!;
      return { report, claim };
    }

    it('un fichier à 47 colonnes reste valide : aucun avertissement, aucun champ Art. 14 sauf la responsabilité déclarée (colonnes 32-33)', async () => {
      const row = buildCsvRow({ ...BASE_ROW, numEconstat: 'ECT-47', compagnieA: 'CAAT', compagnieB: 'SAA', responsabiliteDeclareeA: '25', responsabiliteDeclareeB: '75' });
      const report = await service.importFile('v1.csv', Buffer.from(`${header}\n${row}\n`, 'utf-8'));
      expect(report.rows[0].verdict).toBe('ELIGIBLE_IDA');
      expect(report.warnings).toEqual([]);
      const claim = (await service.list({ page: 1, pageSize: 1000 })).items.find((c) => c.numEconstat === 'ECT-47')!;
      expect(claim).toMatchObject({ responsabiliteDeclareeA: 25, responsabiliteDeclareeB: 75 });
      for (const key of ['circonstancesA', 'circonstancesB', 'baremeVersionId', 'baremeCode', 'vehicleCategoryA', 'vehicleCategoryB'] as const) {
        expect(claim[key]).toBeUndefined();
      }
    });

    it('import : un code ou une catégorie non publiés sont ignorés avec un avertissement « barème non publié » (ligne et colonne), les circonstances sont gardées', async () => {
      const { report, claim } = await importOne('ECT-NP', 'CAAT', 'SAA', { circonstancesA: '8;1;8', baremeCode: 'B01', vehicleCategoryA: 'VL' });
      expect(report.rows[0].verdict).toBe('ELIGIBLE_IDA');
      expect(report.warnings).toEqual([
        expect.objectContaining({ rowNumber: 1, column: 51, columnKey: 'baremeCode', code: 'BAREME_NON_PUBLIE', message: expect.stringContaining('Barème non publié') }),
        expect.objectContaining({ rowNumber: 1, column: 52, columnKey: 'vehicleCategoryA', code: 'BAREME_NON_PUBLIE' }),
      ]);
      expect(claim.circonstancesA).toEqual([1, 8]);
      expect(claim.baremeCode).toBeUndefined();
      expect(claim.vehicleCategoryA).toBeUndefined();
    });

    it('import : un code et une catégorie publiés sont enregistrés avec la version validée', async () => {
      const versionId = await publish();
      const { report, claim } = await importOne('ECT-PUB', 'CAAT', 'SAA', { baremeCode: 'b01', vehicleCategoryA: 'vl', vehicleCategoryB: 'PL' });
      expect(claim).toMatchObject({ baremeCode: 'B01', baremeVersionId: versionId, vehicleCategoryA: 'VL' });
      expect(claim.vehicleCategoryB).toBeUndefined();
      expect(report.warnings).toEqual([expect.objectContaining({ column: 53, code: 'BAREME_NON_PUBLIE' })]);
    });

    it('PATCH : code non publié refusé (400), code publié accepté avec sa version', async () => {
      const { claim } = await importOne('ECT-PATCH-1');
      await expect(service.updateResponsabilite(claim.id, { baremeCode: 'B01' }, correspondant('CAAT'))).rejects.toMatchObject({ status: 400, response: { code: 'BAREME_NON_PUBLIE' } });
      const versionId = await publish();
      const updated = await service.updateResponsabilite(claim.id, { baremeCode: 'B02', circonstancesA: [17, 3], vehicleCategoryB: 'VL' }, correspondant('CAAT'));
      expect(updated).toMatchObject({ baremeCode: 'B02', baremeVersionId: versionId, circonstancesA: [3, 17], vehicleCategoryB: 'VL' });
      await expect(service.updateResponsabilite(claim.id, { vehicleCategoryA: 'PL' }, correspondant('CAAT'))).rejects.toMatchObject({ status: 400 });
    });

    it('PATCH cross-tenant : 403 hors périmètre, et 403 pour la compagnie adverse qui voit le dossier sans l’avoir déclaré', async () => {
      const { claim } = await importOne('ECT-PATCH-2', 'CAAT', 'SAA');
      await expect(service.updateResponsabilite(claim.id, { circonstancesA: [1] }, correspondant('ZZCC'))).rejects.toThrow(ForbiddenException);
      await expect(service.updateResponsabilite(claim.id, { circonstancesA: [1] }, correspondant('SAA'))).rejects.toThrow(ForbiddenException);
    });

    it('PATCH refusé au CORRESPONDANT_IDA une fois un recours ouvert ; un rôle matchDecide de la place peut encore modifier', async () => {
      const { claim } = await importOne('ECT-PATCH-3');
      recoursRows.push({ claimId: claim.id });
      await expect(service.updateResponsabilite(claim.id, { circonstancesA: [2] }, correspondant('CAAT'))).rejects.toMatchObject({ status: 403, response: { code: 'RECOURS_OUVERT' } });
      await expect(service.updateResponsabilite(claim.id, { circonstancesA: [2] }, operateur)).resolves.toMatchObject({ circonstancesA: [2] });
      const sansPrivilege: AuthenticatedUser = { ...operateur, privileges: ['params'] };
      await expect(service.updateResponsabilite(claim.id, { circonstancesA: [4] }, sansPrivilege)).rejects.toThrow(ForbiddenException);
    });

    it('confrontation : divergence et taux selon barème rafraîchis après le PATCH, sans déduction depuis les circonstances', async () => {
      const shared = { ...BASE_ROW, numEconstat: 'ECT-DIV', immatriculationA: '16-1-16', immatriculationB: '31-2-31' };
      const rowA = buildV2Row({ ...shared, compagnieA: 'CAAT', compagnieB: 'SAA' }, { circonstancesA: '8' });
      const rowB = buildV2Row({ ...shared, compagnieA: 'SAA', compagnieB: 'CAAT', immatriculationA: '31-2-31', immatriculationB: '16-1-16' }, {});
      await service.importFile('pair.csv', Buffer.from(`${headerV2}\n${rowA}\n${rowB}\n`, 'utf-8'));
      const claims = (await service.list({ page: 1, pageSize: 1000 })).items.filter((c) => c.numEconstat === 'ECT-DIV');
      const a = claims.find((c) => c.company === 'CAAT')!;
      const b = claims.find((c) => c.company === 'SAA')!;
      const rowOf = async () => (await matchingService.queue({ filter: 'TOUS', page: 1, pageSize: 1000 })).items.find((i) => i.refA === 'ECT-DIV' && i.companyA === 'CAAT')!;

      const before = await rowOf();
      expect(before.responsabiliteA).toMatchObject({ circonstancesA: [8] });
      expect(before.responsabiliteA?.baremeCode).toBeUndefined();
      expect(before.divergence).toBe(false);

      await publish();
      await service.updateResponsabilite(a.id, { baremeCode: 'B01' }, correspondant('CAAT'));
      await service.updateResponsabilite(b.id, { baremeCode: 'B02' }, correspondant('SAA'));
      const after = await rowOf();
      expect(after.divergence).toBe(true);
      expect(after.responsabiliteA).toMatchObject({ baremeCode: 'B01', tauxSelonBareme: { partA: 100, partB: 0 } });
      expect(after.responsabiliteB).toMatchObject({ baremeCode: 'B02', tauxSelonBareme: { partA: 50, partB: 50 } });
    });
  });
});
