import { ClaimsService } from '../claims/claims.service';
import { RecoursService } from '../recours/recours.service';
import { StatsService } from './stats.service';

function fakeClaims(claims: { wilaya?: string; expertAmount?: number; estimatedAmount?: number; accidentDate?: string; createdAt?: string; canalDeclaration?: string }[]): ClaimsService {
  return {
    list: jest.fn(async () => ({ page: 1, total: claims.length, items: claims })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeRecours(recours: { requestSentAt: string; state: string; settledAt?: string; opposition?: { raisedAt: string }; amount: number }[]): RecoursService {
  return {
    listAll: jest.fn(async () => recours),
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
      );

      const monthly = await service.monthly();
      expect(monthly.find((m) => m.month === '2026-09')?.annexes2).toBe(2);
      expect(monthly.find((m) => m.month === '2026-10')?.annexes2).toBe(1);
    });

    it('compte les oppositions par mois de levée (opposition.raisedAt), pas par mois d’ouverture', async () => {
      const service = new StatsService(
        fakeClaims([]),
        fakeRecours([{ requestSentAt: '2026-09-01T00:00:00Z', state: 'OPPOSITION', opposition: { raisedAt: '2026-09-15T00:00:00Z' }, amount: 1000 }]),
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
      );

      const summary = await service.summary();
      expect(summary.settledAmount).toBe(150_000);
      expect(summary.avgSettlementDays).toBe(15);
    });

    it('renvoie avgSettlementDays=null si aucun recours n’est réglé (pas de division par zéro)', async () => {
      const service = new StatsService(fakeClaims([]), fakeRecours([]));
      const summary = await service.summary();
      expect(summary.avgSettlementDays).toBeNull();
      expect(summary.settledAmount).toBe(0);
      expect(summary.oppositionRatePct).toBe(0);
    });
  });
});
