import {
  computeCompositeScore,
  computeDelaisScore,
  computeDemandesTardivesScore,
  computeForclusionsScore,
  computeQualiteDonneesScore,
  MONITORING_WEIGHTS,
  MonitoringComponentKey,
  MonitoringComponentValue,
  ClaimMonitoringInput,
} from './monitoring.scoring';

function claim(overrides: Partial<ClaimMonitoringInput>): ClaimMonitoringInput {
  return { company: 'CAAT', createdAt: '2026-01-10T00:00:00.000Z', ...overrides };
}

describe('monitoring.scoring (fonctions pures)', () => {
  describe('computeDelaisScore', () => {
    it('renvoie NON_DISPONIBLE sans aucune date exploitable', () => {
      expect(computeDelaisScore([])).toEqual({ value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 });
    });

    it('score 100 quand ingestion le jour même de l’accident', () => {
      const r = computeDelaisScore([claim({ accidentDate: '2026-01-10', createdAt: '2026-01-10T08:00:00.000Z' })]);
      expect(r.dataSource).toBe('REEL');
      expect(r.value).toBe(100);
    });

    it('pénalise la latence (2 jours × 2 pts/jour ⇒ -4 points)', () => {
      const r = computeDelaisScore([claim({ accidentDate: '2026-01-10', createdAt: '2026-01-12T00:00:00.000Z' })]);
      expect(r.value).toBe(96);
    });

    it('plancher à 0 (latence extrême)', () => {
      const r = computeDelaisScore([claim({ accidentDate: '2026-01-01', createdAt: '2026-06-01T00:00:00.000Z' })]);
      expect(r.value).toBe(0);
    });
  });

  describe('computeQualiteDonneesScore', () => {
    it('NON_DISPONIBLE sans dossier', () => {
      expect(computeQualiteDonneesScore([]).dataSource).toBe('NON_DISPONIBLE');
    });

    it('100 si aucune erreur de format', () => {
      const r = computeQualiteDonneesScore([claim({ eligibilityReasons: ['Montant > plafond — Art. 4'] })]);
      expect(r.value).toBe(100);
    });

    it('réduit le score au prorata des erreurs de format', () => {
      const r = computeQualiteDonneesScore([
        claim({ eligibilityReasons: ['Erreur de format : montant non numérique'] }),
        claim({ eligibilityReasons: [] }),
      ]);
      expect(r.value).toBe(50);
    });
  });

  describe('computeForclusionsScore', () => {
    it('100 sans forclusion', () => {
      const r = computeForclusionsScore([claim({ eligibilityReasons: [] })]);
      expect(r.value).toBe(100);
    });

    it('détecte un motif de forclusion (Art. 19)', () => {
      const r = computeForclusionsScore([
        claim({ eligibilityReasons: ['Recours introduit après le délai — forclusion, Art. 19'] }),
        claim({ eligibilityReasons: [] }),
      ]);
      expect(r.value).toBe(50);
    });
  });

  describe('computeDemandesTardivesScore', () => {
    it('NON_DISPONIBLE sans date de recours', () => {
      expect(computeDemandesTardivesScore([claim({})], 6).dataSource).toBe('NON_DISPONIBLE');
    });

    it('ne compte pas tardif un recours introduit rapidement', () => {
      const r = computeDemandesTardivesScore(
        [claim({ accidentDate: '2026-01-01', dateDemandeRecours: '2026-01-15' })],
        6,
      );
      expect(r.value).toBe(100);
    });

    it('compte tardif un recours introduit après plus de la moitié du délai, non forclos', () => {
      const r = computeDemandesTardivesScore(
        [claim({ accidentDate: '2026-01-01', dateDemandeRecours: '2026-04-15', eligibilityReasons: [] })],
        6, // 180 jours, seuil tardif = 90 jours ; 104 jours écoulés > seuil mais < délai
      );
      expect(r.value).toBe(0);
    });

    it('ne recompte pas un dossier déjà forclos comme "tardif"', () => {
      const r = computeDemandesTardivesScore(
        [
          claim({
            accidentDate: '2026-01-01',
            dateDemandeRecours: '2026-12-01',
            eligibilityReasons: ['forclusion, Art. 19'],
          }),
        ],
        6,
      );
      expect(r.value).toBe(100);
    });
  });

  describe('computeCompositeScore', () => {
    function fullDetails(overrides: Partial<Record<MonitoringComponentKey, MonitoringComponentValue>>) {
      const base: Record<MonitoringComponentKey, MonitoringComponentValue> = {
        delais: { value: 100, dataSource: 'REEL', sampleSize: 1 },
        silences: { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 },
        oppositions: { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 },
        qualiteDonnees: { value: 100, dataSource: 'REEL', sampleSize: 1 },
        forclusions: { value: 100, dataSource: 'REEL', sampleSize: 1 },
        demandesTardives: { value: 100, dataSource: 'REEL', sampleSize: 1 },
        penalites: { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 },
      };
      return { ...base, ...overrides };
    }

    it('renvoie 100 si toutes les composantes disponibles valent 100 (renormalisation)', () => {
      expect(computeCompositeScore(fullDetails({}))).toBe(100);
    });

    it('renvoie null si aucune composante n’est disponible', () => {
      const allNull = fullDetails({
        delais: { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 },
        qualiteDonnees: { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 },
        forclusions: { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 },
        demandesTardives: { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 },
      });
      expect(computeCompositeScore(allNull)).toBeNull();
    });

    it('pondère correctement un mélange de composantes disponibles', () => {
      // délais (30%) = 0, qualiteDonnees (15%) = 100 → poids dispo 45% → (0*0.30 + 100*0.15)/0.45 = 33.3
      const details = fullDetails({
        delais: { value: 0, dataSource: 'REEL', sampleSize: 1 },
        forclusions: { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 },
        demandesTardives: { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 },
      });
      expect(computeCompositeScore(details)).toBeCloseTo(33.3, 1);
    });
  });

  it('les pondérations du dossier technique totalisent 100% (B.2 écran 8)', () => {
    const total = Object.values(MONITORING_WEIGHTS).reduce((s, w) => s + w, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});
