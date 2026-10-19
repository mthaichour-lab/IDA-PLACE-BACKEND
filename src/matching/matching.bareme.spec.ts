import { PublishedBaremeCase } from '../adherents/bareme-rules';
import { compactResponsabilite, computeDivergence, withTauxSelonBareme } from './matching.bareme';

const CASES: PublishedBaremeCase[] = [{ versionId: 'v1', versionLabel: 'Barème 2026', validatedAt: '2026-10-01T00:00:00.000Z', code: 'B01', label: 'Cas 1', partA: 100, partB: 0 }];

describe('confrontation Art. 14 (décision PO §5)', () => {
  describe('divergence', () => {
    it('vraie seulement si A et B portent chacun un code et que ces codes diffèrent', () => {
      expect(computeDivergence({ baremeCode: 'B01' }, { baremeCode: 'B02' })).toBe(true);
      expect(computeDivergence({ baremeCode: 'B01' }, { baremeCode: 'B01' })).toBe(false);
      expect(computeDivergence({ baremeCode: 'B01' }, {})).toBe(false);
      expect(computeDivergence({ baremeCode: 'B01' }, undefined)).toBe(false);
      expect(computeDivergence(undefined, undefined)).toBe(false);
    });

    it('les circonstances seules ne créent aucune divergence (pas de déduction du code)', () => {
      expect(computeDivergence({ circonstancesA: [8] }, { circonstancesA: [1] })).toBe(false);
    });
  });

  describe('taux selon barème', () => {
    it('absent sans barème validé', () => {
      expect(withTauxSelonBareme({ baremeCode: 'B01', baremeVersionId: 'v1', responsabiliteDeclareeA: 50 }, [])).toEqual({ baremeCode: 'B01', baremeVersionId: 'v1', responsabiliteDeclareeA: 50 });
    });

    it('absent si la version du dossier n’est plus validée, même si une autre version contient le code', () => {
      expect(withTauxSelonBareme({ baremeCode: 'B01', baremeVersionId: 'v-archivee' }, CASES)?.tauxSelonBareme).toBeUndefined();
    });

    it('présent à côté du taux déclaré quand une version VALIDE_UAR couvre le code', () => {
      expect(withTauxSelonBareme({ baremeCode: 'B01', baremeVersionId: 'v1', responsabiliteDeclareeA: 50 }, CASES)).toEqual({
        baremeCode: 'B01',
        baremeVersionId: 'v1',
        responsabiliteDeclareeA: 50,
        tauxSelonBareme: { baremeVersionId: 'v1', versionLabel: 'Barème 2026', partA: 100, partB: 0 },
      });
    });

    it('jamais calculé à partir des seules circonstances', () => {
      expect(withTauxSelonBareme({ circonstancesA: [8] }, CASES)).toEqual({ circonstancesA: [8] });
    });
  });

  it('un bloc sans aucune valeur est omis (dossier antérieur au modèle étendu)', () => {
    expect(compactResponsabilite({ circonstancesA: [], baremeCode: undefined })).toBeUndefined();
    expect(compactResponsabilite({ responsabiliteDeclareeA: 0 })).toEqual({ responsabiliteDeclareeA: 0 });
  });
});
