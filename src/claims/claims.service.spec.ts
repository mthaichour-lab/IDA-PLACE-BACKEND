import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { EligibilityService } from '../eligibility/eligibility.service';
import { MatchQueueItem } from '../matching/entities/match-queue-item.entity';
import { MatchingService } from '../matching/matching.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import { CLAIM_IMPORT_COLUMNS } from './claim-47-columns';
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

  beforeEach(async () => {
    emitEvent = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ClaimsService,
        EligibilityService,
        MatchingService,
        { provide: getRepositoryToken(Claim), useFactory: throwingRepo },
        { provide: getRepositoryToken(MatchQueueItem), useFactory: throwingRepo },
        { provide: ConfigService, useFactory: fakeConfigService },
        { provide: RealtimeGateway, useValue: { emitEvent } },
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
});
