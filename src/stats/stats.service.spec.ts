import { AdherentsService } from '../adherents/adherents.service';
import { IrsamReference, PopulationReference } from '../adherents/place-metrics-referential.service';
import { buildWilayaSeeds } from '../adherents/wilayas.data';
import { ClaimsService } from '../claims/claims.service';
import { RecoursService } from '../recours/recours.service';
import { StatsService } from './stats.service';

function fakeClaims(
  claims: { wilaya?: string; expertAmount?: number; estimatedAmount?: number; accidentDate?: string; createdAt?: string; canalDeclaration?: string; baremeCode?: string; vehicleCategoryA?: string }[],
): ClaimsService {
  return {
    listAllForAnalysis: jest.fn(async () => ({ items: claims, truncated: false })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeRecours(recours: { requestSentAt: string; state: string; settledAt?: string; opposition?: { raisedAt: string }; amount: number }[]): RecoursService {
  return {
    listAll: jest.fn(async () => recours),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeAdherents(
  populations: Record<string, PopulationReference> = {},
  irsam: IrsamReference = { status: 'NON_RENSEIGNE', benchmark: null },
): AdherentsService & { populationReferences: jest.Mock } {
  return {
    listWilayas: jest.fn(async () => buildWilayaSeeds()),
    populationReferences: jest.fn(async () => populations),
    irsamReference: jest.fn(async () => irsam),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('StatsService', () => {
  describe('monthly() — Annexes 2 / oppositions / indemnisés (RecoursModule réel)', () => {
    it('compte les Annexes 2 émises (ouverture de recours) par mois civil', async () => {
      const service = new StatsService(
        fakeClaims([]),
        fakeRecours([
          { requestSentAt: '2026-09-10T00:00:00Z', state: 'EN_ATTENTE', amount: 1000 },
          { requestSentAt: '2026-09-20T00:00:00Z', state: 'EN_ATTENTE', amount: 1000 },
          { requestSentAt: '2026-10-01T00:00:00Z', state: 'EN_ATTENTE', amount: 1000 },
        ]),
        fakeAdherents(),
      );

      const monthly = await service.monthly();
      expect(monthly.find((m) => m.month === '2026-09')?.annexes2).toBe(2);
      expect(monthly.find((m) => m.month === '2026-10')?.annexes2).toBe(1);
    });

    it('compte les oppositions par mois de levée (opposition.raisedAt), pas par mois d’ouverture', async () => {
      const service = new StatsService(
        fakeClaims([]),
        fakeRecours([{ requestSentAt: '2026-09-01T00:00:00Z', state: 'OPPOSITION', opposition: { raisedAt: '2026-09-15T00:00:00Z' }, amount: 1000 }]),
        fakeAdherents(),
      );

      const monthly = await service.monthly();
      expect(monthly.find((m) => m.month === '2026-09')?.oppositions).toBe(1);
    });

    it('compte les recours réglés ("indemnisés") par mois de règlement (settledAt), uniquement state REGLE', async () => {
      const service = new StatsService(
        fakeClaims([]),
        fakeRecours([
          { requestSentAt: '2026-08-01T00:00:00Z', state: 'REGLE', settledAt: '2026-09-05T00:00:00Z', amount: 1000 },
          { requestSentAt: '2026-08-01T00:00:00Z', state: 'REJETE', settledAt: '2026-09-06T00:00:00Z', amount: 1000 }, // rejeté — ne compte pas comme "indemnisé"
        ]),
        fakeAdherents(),
      );

      const monthly = await service.monthly();
      expect(monthly.find((m) => m.month === '2026-09')?.indemnises).toBe(1);
    });
  });

  describe('summary() — KPI de synthèse', () => {
    it('calcule le taux d’opposition sur l’ensemble des recours', async () => {
      const service = new StatsService(
        fakeClaims([{}, {}]),
        fakeRecours([
          { requestSentAt: '2026-09-01T00:00:00Z', state: 'OPPOSITION', opposition: { raisedAt: '2026-09-02T00:00:00Z' }, amount: 1000 },
          { requestSentAt: '2026-09-01T00:00:00Z', state: 'EN_ATTENTE', amount: 1000 },
          { requestSentAt: '2026-09-01T00:00:00Z', state: 'EN_ATTENTE', amount: 1000 },
          { requestSentAt: '2026-09-01T00:00:00Z', state: 'EN_ATTENTE', amount: 1000 },
        ]),
        fakeAdherents(),
      );

      const summary = await service.summary();
      expect(summary.oppositionRatePct).toBe(25);
      expect(summary.declarations).toBe(2);
    });

    it('calcule le montant compensé et le délai moyen de règlement sur les recours REGLE uniquement', async () => {
      const service = new StatsService(
        fakeClaims([]),
        fakeRecours([
          { requestSentAt: '2026-09-01T00:00:00Z', state: 'REGLE', settledAt: '2026-09-11T00:00:00Z', amount: 100_000 }, // 10 jours
          { requestSentAt: '2026-09-01T00:00:00Z', state: 'REGLE', settledAt: '2026-09-21T00:00:00Z', amount: 50_000 }, // 20 jours
          { requestSentAt: '2026-09-01T00:00:00Z', state: 'EN_ATTENTE', amount: 999_999 }, // non réglé — exclu
        ]),
        fakeAdherents(),
      );

      const summary = await service.summary();
      expect(summary.settledAmount).toBe(150_000);
      expect(summary.avgSettlementDays).toBe(15);
    });

    it('renvoie avgSettlementDays=null si aucun recours n’est réglé (pas de division par zéro)', async () => {
      const service = new StatsService(fakeClaims([]), fakeRecours([]), fakeAdherents());
      const summary = await service.summary();
      expect(summary.avgSettlementDays).toBeNull();
      expect(summary.settledAmount).toBe(0);
      expect(summary.oppositionRatePct).toBe(0);
    });
  });
  describe('wilayas() — per100k (décision PO §3)', () => {
    it('per100k est null (jamais 0) quand aucune population valide n’existe', async () => {
      const service = new StatsService(fakeClaims([{ wilaya: '16' }, { wilaya: '16' }]), fakeRecours([]), fakeAdherents());
      const tiles = await service.wilayas();
      const alger = tiles.find((w) => w.code === '16')!;
      expect(alger.declarations).toBe(2);
      expect(alger.per100k).toBeNull();
      expect(alger.populationRef).toBeNull();
      expect(tiles.every((w) => w.per100k === null)).toBe(true);
    });

    it('per100k est calculé à partir de la population de référence (source et année exposées)', async () => {
      const ref: PopulationReference = { population: 200_000, referenceYear: 2024, sourceType: 'ESTIMATION_ONS', sourceRef: 'ONS 2024' };
      const service = new StatsService(
        fakeClaims([
          { wilaya: '16', accidentDate: '2025-02-01' },
          { wilaya: '16', accidentDate: '2025-06-01' },
          { wilaya: '31', accidentDate: '2025-04-01' },
        ]),
        fakeRecours([]),
        fakeAdherents({ '16': ref }),
      );
      const tiles = await service.wilayas(2025);
      expect(tiles.find((w) => w.code === '16')).toMatchObject({ declarations: 2, per100k: 1, populationRef: ref });
      expect(tiles.find((w) => w.code === '31')).toMatchObject({ declarations: 1, per100k: null });
    });

    it('sans year (cumul toutes années), per100k reste null même si une population existe', async () => {
      const ref: PopulationReference = { population: 200_000, referenceYear: 2024, sourceType: 'ESTIMATION_ONS', sourceRef: 'ONS 2024' };
      const adherents = fakeAdherents({ '16': ref });
      const service = new StatsService(fakeClaims([{ wilaya: '16' }, { wilaya: '16' }]), fakeRecours([]), adherents);
      const tiles = await service.wilayas();
      expect(tiles.find((w) => w.code === '16')).toMatchObject({ declarations: 2, per100k: null, populationRef: null });
      expect(adherents.populationReferences).not.toHaveBeenCalled();
    });

    it('year : ne compte que les déclarations de l’année étudiée et demande la population de cette année', async () => {
      const adherents = fakeAdherents();
      const service = new StatsService(
        fakeClaims([
          { wilaya: '16', accidentDate: '2025-03-01' },
          { wilaya: '16', accidentDate: '2026-03-01' },
        ]),
        fakeRecours([]),
        adherents,
      );
      const tiles = await service.wilayas(2025);
      expect(tiles.find((w) => w.code === '16')?.declarations).toBe(1);
      expect(adherents.populationReferences).toHaveBeenCalledWith(2025);
    });
  });

  describe('summary() — comparatif IRSAM (décision PO §4)', () => {
    const settled = [{ requestSentAt: '2026-09-01T00:00:00Z', state: 'REGLE', settledAt: '2026-09-11T00:00:00Z', amount: 1000 }]; // 10 jours

    it('irsam est null tant qu’aucune référence n’est validée UAR, avec le statut d’attente', async () => {
      const service = new StatsService(fakeClaims([]), fakeRecours(settled), fakeAdherents({}, { status: 'EN_ATTENTE_VALIDATION', benchmark: null }));
      const summary = await service.summary();
      expect(summary.irsam).toBeNull();
      expect(summary.irsamStatus).toBe('EN_ATTENTE_VALIDATION');
      expect(summary.avgSettlementDays).toBe(10);
    });

    it('irsam expose la référence validée et l’écart avec le délai moyen IDA', async () => {
      const measureDefinition = { startEvent: 'Envoi Annexe 2', endEvent: 'Règlement', scope: 'Recours matériels' };
      const benchmark = {
        id: 'b1',
        indicator: 'DELAI_MOYEN_REGLEMENT_RECOURS_JOURS' as const,
        value: 74,
        periodFrom: '2025-01-01',
        periodTo: '2025-12-31',
        measureDefinition,
        sourceRef: 'E-Recours 2025',
        status: 'VALIDE_UAR' as const,
        createdBy: 'op',
        createdAt: '2026-01-01T00:00:00Z',
        validatedBy: 'uar',
      };
      const service = new StatsService(fakeClaims([]), fakeRecours(settled), fakeAdherents({}, { status: 'VALIDE', benchmark }));
      const summary = await service.summary();
      expect(summary.irsamStatus).toBe('VALIDE');
      expect(summary.irsam).toEqual({ value: 74, periodFrom: '2025-01-01', periodTo: '2025-12-31', sourceRef: 'E-Recours 2025', measureDefinition, deltaDays: -64 });
    });
  });

  describe('summary() : répartition par code de barème et par catégorie (décision PO §5)', () => {
    it('compte chaque valeur saisie et, à part, les dossiers sans valeur', async () => {
      const claims = [
        { baremeCode: 'B01', vehicleCategoryA: 'VL' },
        { baremeCode: 'B01' },
        { baremeCode: 'B03', vehicleCategoryA: 'PL' },
        {},
      ];
      const summary = await new StatsService(fakeClaims(claims), fakeRecours([]), fakeAdherents()).summary();
      expect(summary.declarations).toBe(4);
      expect(summary.baremeCodes).toEqual({ items: [{ code: 'B01', count: 2 }, { code: 'B03', count: 1 }], sansValeur: 1 });
      expect(summary.vehicleCategories).toEqual({ items: [{ code: 'PL', count: 1 }, { code: 'VL', count: 1 }], sansValeur: 2 });
    });

    it('aucun dossier renseigné : listes vides, tout est compté sans valeur', async () => {
      const summary = await new StatsService(fakeClaims([{}, {}]), fakeRecours([]), fakeAdherents()).summary();
      expect(summary.baremeCodes).toEqual({ items: [], sansValeur: 2 });
      expect(summary.vehicleCategories).toEqual({ items: [], sansValeur: 2 });
    });
  });
});
