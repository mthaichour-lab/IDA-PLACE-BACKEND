import { EntityRepository } from '@mikro-orm/postgresql';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { IrsamBenchmark } from './entities/irsam-benchmark.entity';
import { Wilaya } from './entities/wilaya.entity';
import { WilayaPopulation } from './entities/wilaya-population.entity';
import { PlaceMetricsReferentialService } from './place-metrics-referential.service';
import { populationInvalidReason } from './referential-rules';

/** Repli mémoire forcé : toute opération base échoue (voir adherents.service.spec.ts). */
function throwingRepo<T extends object>(): EntityRepository<T> {
  const fail = jest.fn().mockRejectedValue(new Error('DB injoignable (test)'));
  return {
    findAll: fail,
    find: fail,
    findOne: fail,
    findOneOrFail: fail,
    create: jest.fn((d: unknown) => d),
    assign: jest.fn(),
    getEntityManager: jest.fn(() => ({ persist: jest.fn(), persistAndFlush: fail, flush: fail })),
  } as unknown as EntityRepository<T>;
}

function user(id: string, role: AuthenticatedUser['role'] = 'OPERATEUR_PLACE'): AuthenticatedUser {
  return { id, name: id, email: `${id}@test.dz`, role, privileges: [] };
}

const MEASURE = { startEvent: 'Envoi de la demande de recours', endEvent: 'Règlement', scope: 'Recours matériels E-Recours' };

describe('PlaceMetricsReferentialService (mode dégradé)', () => {
  let service: PlaceMetricsReferentialService;
  const operateur = user('op-1');
  const adminUar = user('uar-1', 'ADMIN_UAR');

  beforeEach(() => {
    service = new PlaceMetricsReferentialService(throwingRepo<Wilaya>(), throwingRepo<WilayaPopulation>(), throwingRepo<IrsamBenchmark>());
  });

  it('seed : aucune population, aucune référence IRSAM, aucun périmètre ni nom pour les wilayas 59-69', async () => {
    expect(await service.listPopulations()).toEqual([]);
    expect(await service.listIrsam()).toEqual([]);
    expect(await service.populationReferences(2100)).toEqual({});
    const wilayas = await service.listWilayas();
    expect(wilayas.every((w) => w.effectiveFrom === undefined && w.parentCode === undefined)).toBe(true);
    expect(wilayas.filter((w) => Number(w.code) >= 59).every((w) => w.name.includes('à vérifier'))).toBe(true);
  });

  describe('validité d’une population au regard du périmètre (§3)', () => {
    const perimeters = [{ code: '01' }, { code: '49', effectiveFrom: '2019-12-18', parentCode: '01' }];

    it('invalide pour la wilaya fille si l’année précède effectiveFrom, valide ensuite', () => {
      expect(populationInvalidReason('49', 2019, perimeters)).toMatch(/antérieure au périmètre actuel/);
      expect(populationInvalidReason('49', 2020, perimeters)).toBeUndefined();
    });

    it('invalide aussi pour la wilaya mère avant le détachement de sa fille', () => {
      expect(populationInvalidReason('01', 2008, perimeters)).toMatch(/détachement de la wilaya 49/);
      expect(populationInvalidReason('01', 2020, perimeters)).toBeUndefined();
    });

    it('createPopulation refuse (400) une population antérieure à effectiveFrom', async () => {
      await service.updateWilayaPerimeter('49', { effectiveFrom: '2019-12-18', parentCode: '01' });
      await expect(
        service.createPopulation({ wilayaCode: '49', referenceYear: 2008, population: 10_000, sourceType: 'RECENSEMENT_RGPH', sourceRef: 'RGPH 2008' }, operateur),
      ).rejects.toMatchObject({ response: { code: 'POPULATION_INVALIDE' } });
    });

    it('une population devenue invalide après coup est signalée et ignorée par populationReferences', async () => {
      await service.createPopulation({ wilayaCode: '01', referenceYear: 2008, population: 400_000, sourceType: 'RECENSEMENT_RGPH', sourceRef: 'RGPH 2008' }, operateur);
      expect(await service.populationReferences(2026)).toHaveProperty('01');
      await service.updateWilayaPerimeter('49', { effectiveFrom: '2019-12-18', parentCode: '01' });
      const [row] = await service.listPopulations('01');
      expect(row.valid).toBe(false);
      expect(row.invalidReason).toMatch(/49/);
      expect(await service.populationReferences(2026)).toEqual({});
    });
  });

  describe('populationReferences — année ≤ année étudiée, la plus récente, sans interpolation', () => {
    it('retient la plus récente des années ≤ year, rien si toutes sont postérieures', async () => {
      await service.createPopulation({ wilayaCode: '16', referenceYear: 2008, population: 2_988_145, sourceType: 'RECENSEMENT_RGPH', sourceRef: 'RGPH 2008' }, operateur);
      await service.createPopulation({ wilayaCode: '16', referenceYear: 2024, population: 3_500_000, sourceType: 'ESTIMATION_ONS', sourceRef: 'ONS 2024' }, operateur);
      expect((await service.populationReferences(2020))['16']).toMatchObject({ referenceYear: 2008, population: 2_988_145 });
      expect((await service.populationReferences(2025))['16']).toMatchObject({ referenceYear: 2024, sourceRef: 'ONS 2024' });
      expect(await service.populationReferences(2000)).toEqual({});
    });

    it('refuse un doublon (wilaya, année) avec un 409', async () => {
      const dto = { wilayaCode: '31', referenceYear: 2024, population: 1, sourceType: 'AUTRE' as const, sourceRef: 'x' };
      await service.createPopulation(dto, operateur);
      await expect(service.createPopulation(dto, operateur)).rejects.toMatchObject({ response: { code: 'CONFLICT' } });
    });
  });

  describe('import CSV — tout ou rien, rapport ligne par ligne', () => {
    it('écrit toutes les lignes quand aucune n’est rejetée', async () => {
      const csv = 'code;annee;population;source_type;source_ref\n16;2024;3 500 000;ESTIMATION_ONS;ONS 2024\n9;2024;1200000;ESTIMATION_ONS;ONS 2024\n';
      const report = await service.importPopulations('pop.csv', Buffer.from(csv), operateur);
      expect(report).toMatchObject({ totalRows: 2, acceptedCount: 2, rejectedCount: 0, written: true, writtenCount: 2 });
      expect(report.rows[1]).toMatchObject({ line: 3, status: 'ACCEPTEE', wilayaCode: '09', population: 1_200_000 });
      expect(await service.listPopulations()).toHaveLength(2);
    });

    it('n’écrit rien dès qu’une ligne est rejetée, et donne la raison de chaque rejet', async () => {
      await service.createPopulation({ wilayaCode: '05', referenceYear: 2024, population: 1, sourceType: 'AUTRE', sourceRef: 'x' }, operateur);
      const csv = [
        '16;2024;3500000;ESTIMATION_ONS;ONS 2024',
        '16;2024;3500000;ESTIMATION_ONS;ONS 2024',
        '99;2024;10;AUTRE;x',
        '05;2024;10;AUTRE;x',
        '06;2024;0;AUTRE;x',
        '07;2024;10;INVENTE;x',
        '08;2024;10;AUTRE;',
        '10;2024;10',
      ].join('\r\n');
      const report = await service.importPopulations('pop.csv', Buffer.from(csv), operateur);
      expect(report).toMatchObject({ totalRows: 8, acceptedCount: 1, rejectedCount: 7, written: false, writtenCount: 0 });
      expect(report.rows.map((r) => r.status)).toEqual(['ACCEPTEE', 'REJETEE', 'REJETEE', 'REJETEE', 'REJETEE', 'REJETEE', 'REJETEE', 'REJETEE']);
      expect(report.rows[1].reason).toMatch(/Doublon de la ligne 1/);
      expect(report.rows[2].reason).toMatch(/introuvable/);
      expect(report.rows[3].reason).toMatch(/déjà saisie/);
      expect(report.rows[4].reason).toMatch(/Population invalide/);
      expect(report.rows[5].reason).toMatch(/source_type/);
      expect(report.rows[6].reason).toMatch(/source_ref/);
      expect(report.rows[7].reason).toMatch(/5 colonnes/);
      expect(await service.listPopulations()).toHaveLength(1);
    });

    it('rapporte TOUTES les erreurs indépendantes d’une même ligne, pas seulement la première', async () => {
      const csv = 'code;annee;population;source_type;source_ref\n99;18xx;-5;INVENTE;\n';
      const report = await service.importPopulations('pop.csv', Buffer.from(csv), operateur);
      expect(report.rejectedCount).toBe(1);
      expect(report.rows[0].reason).toMatch(/introuvable/);
      expect(report.rows[0].reason).toMatch(/Année invalide/);
      expect(report.rows[0].reason).toMatch(/Population invalide/);
      expect(report.rows[0].reason).toMatch(/source_type invalide/);
      expect(report.rows[0].reason).toMatch(/source_ref obligatoire/);
    });

    it('400 sur un fichier vide', async () => {
      await expect(service.importPopulations('vide.csv', Buffer.from('code;annee;population;source_type;source_ref\n'), operateur)).rejects.toMatchObject({
        response: { code: 'BAD_REQUEST' },
      });
    });
  });

  describe('référence IRSAM (§4)', () => {
    const dto = { indicator: 'DELAI_MOYEN_REGLEMENT_RECOURS_JOURS' as const, value: 60, periodFrom: '2025-01-01', periodTo: '2025-12-31', measureDefinition: MEASURE, sourceRef: 'E-Recours 2025' };

    it('irsamReference reste sans valeur tant qu’aucune référence n’est validée UAR', async () => {
      expect(await service.irsamReference('DELAI_MOYEN_REGLEMENT_RECOURS_JOURS')).toEqual({ status: 'NON_RENSEIGNE', benchmark: null });
      await service.createIrsam(dto, operateur);
      expect(await service.irsamReference('DELAI_MOYEN_REGLEMENT_RECOURS_JOURS')).toEqual({ status: 'EN_ATTENTE_VALIDATION', benchmark: null });
    });

    it('quatre yeux : 409 si l’auteur valide ; validation par un autre, qui archive la référence précédente', async () => {
      const first = await service.createIrsam(dto, adminUar);
      await expect(service.validateIrsam(first.id, adminUar)).rejects.toMatchObject({ response: { code: 'FOUR_EYES' } });
      await service.validateIrsam(first.id, user('uar-2', 'ADMIN_UAR'));
      expect((await service.irsamReference('DELAI_MOYEN_REGLEMENT_RECOURS_JOURS')).benchmark).toMatchObject({ id: first.id, value: 60 });

      const second = await service.createIrsam({ ...dto, value: 55, periodFrom: '2026-01-01', periodTo: '2026-06-30' }, operateur);
      await service.validateIrsam(second.id, adminUar);
      const list = await service.listIrsam();
      expect(list.find((b) => b.id === first.id)?.status).toBe('ARCHIVE');
      expect(await service.irsamReference('DELAI_MOYEN_REGLEMENT_RECOURS_JOURS')).toMatchObject({ status: 'VALIDE', benchmark: { id: second.id, value: 55 } });

      await service.archiveIrsam(second.id);
      expect(await service.irsamReference('DELAI_MOYEN_REGLEMENT_RECOURS_JOURS')).toEqual({ status: 'NON_RENSEIGNE', benchmark: null });
    });

    it('refuse une période inversée', async () => {
      await expect(service.createIrsam({ ...dto, periodFrom: '2026-01-01', periodTo: '2025-01-01' }, operateur)).rejects.toMatchObject({ response: { code: 'BAD_REQUEST' } });
    });
  });
});
