import {
  detectAbInconsistencies,
  detectCalibratedAmounts,
  detectDuplicates,
  detectEconstatReuse,
  detectVehicleRecurrence,
  FraudClaimInput,
  severityForScore,
} from './fraud.detection';

function c(overrides: Partial<FraudClaimInput> & { id: string }): FraudClaimInput {
  return { company: 'CAAT', createdAt: '2026-01-10T00:00:00.000Z', ...overrides };
}

describe('fraud.detection (fonctions pures)', () => {
  describe('severityForScore', () => {
    it('FAIBLE < 40, MOYEN [40,70), ELEVE >= 70', () => {
      expect(severityForScore(10)).toBe('FAIBLE');
      expect(severityForScore(40)).toBe('MOYEN');
      expect(severityForScore(69)).toBe('MOYEN');
      expect(severityForScore(70)).toBe('ELEVE');
    });
  });

  describe('detectDuplicates', () => {
    it('ne signale rien sans collision', () => {
      expect(detectDuplicates([c({ id: '1', plateA: '16-1-16', accidentDate: '2026-01-10' })])).toHaveLength(0);
    });

    it('détecte 2 déclarations de la même compagnie, même plaque, même jour', () => {
      const cases = detectDuplicates([
        c({ id: '1', plateA: '16-1-16', accidentDate: '2026-01-10' }),
        c({ id: '2', plateA: '16-1-16', accidentDate: '2026-01-10' }),
      ]);
      expect(cases).toHaveLength(1);
      expect(cases[0].type).toBe('DOUBLON');
      expect(cases[0].claimIds).toEqual(['1', '2']);
    });

    it('ne confond pas un appariement normal inter-compagnies avec un doublon', () => {
      const cases = detectDuplicates([
        c({ id: '1', company: 'CAAT', plateA: '16-1-16', accidentDate: '2026-01-10' }),
        c({ id: '2', company: 'SAA', plateA: '31-2-31', accidentDate: '2026-01-10' }),
      ]);
      expect(cases).toHaveLength(0);
    });
  });

  describe('detectEconstatReuse', () => {
    it('ne signale pas 2 déclarations cohérentes partageant le même e-constat (cas normal B.5)', () => {
      const cases = detectEconstatReuse([
        c({ id: '1', numEconstat: 'ECT-1', accidentDate: '2026-01-10', wilaya: '16' }),
        c({ id: '2', numEconstat: 'ECT-1', accidentDate: '2026-01-10', wilaya: '16' }),
      ]);
      expect(cases).toHaveLength(0);
    });

    it('signale 2 déclarations au même e-constat mais wilaya divergente', () => {
      const cases = detectEconstatReuse([
        c({ id: '1', numEconstat: 'ECT-2', accidentDate: '2026-01-10', wilaya: '16' }),
        c({ id: '2', numEconstat: 'ECT-2', accidentDate: '2026-01-10', wilaya: '31' }),
      ]);
      expect(cases).toHaveLength(1);
      expect(cases[0].type).toBe('ECONSTAT_REUTILISE');
    });

    it('signale un e-constat porté par plus de 2 déclarations', () => {
      const cases = detectEconstatReuse([
        c({ id: '1', numEconstat: 'ECT-3', accidentDate: '2026-01-10', wilaya: '16' }),
        c({ id: '2', numEconstat: 'ECT-3', accidentDate: '2026-01-10', wilaya: '16' }),
        c({ id: '3', numEconstat: 'ECT-3', accidentDate: '2026-01-10', wilaya: '16' }),
      ]);
      expect(cases).toHaveLength(1);
      expect(cases[0].claimIds).toHaveLength(3);
    });
  });

  describe('detectVehicleRecurrence', () => {
    it('ne signale rien si la plaque n’apparaît que chez une seule compagnie', () => {
      const cases = detectVehicleRecurrence([
        c({ id: '1', company: 'CAAT', plateA: '16-1-16', accidentDate: '2026-01-10' }),
        c({ id: '2', company: 'CAAT', plateA: '16-1-16', accidentDate: '2026-02-10' }),
      ]);
      expect(cases).toHaveLength(0);
    });

    it('signale une plaque partagée par 2 compagnies dans la fenêtre temporelle', () => {
      const cases = detectVehicleRecurrence(
        [
          c({ id: '1', company: 'CAAT', plateA: '16-1-16', accidentDate: '2026-01-10' }),
          c({ id: '2', company: 'SAA', plateA: '16-1-16', accidentDate: '2026-02-01' }),
        ],
        90,
      );
      expect(cases).toHaveLength(1);
      expect(cases[0].companiesInvolved.sort()).toEqual(['CAAT', 'SAA']);
    });

    it('ne signale pas si hors fenêtre temporelle', () => {
      const cases = detectVehicleRecurrence(
        [
          c({ id: '1', company: 'CAAT', plateA: '16-1-16', accidentDate: '2026-01-01' }),
          c({ id: '2', company: 'SAA', plateA: '16-1-16', accidentDate: '2026-12-01' }),
        ],
        90,
      );
      expect(cases).toHaveLength(0);
    });
  });

  describe('detectCalibratedAmounts', () => {
    it('signale une concentration de montants juste sous le plafond pour une compagnie', () => {
      const cases = detectCalibratedAmounts(
        [
          c({ id: '1', estimatedAmount: 295_000 }),
          c({ id: '2', estimatedAmount: 290_000 }),
          c({ id: '3', estimatedAmount: 298_000 }),
        ],
        300_000,
        0.9,
        3,
      );
      expect(cases).toHaveLength(1);
      expect(cases[0].type).toBe('MONTANT_CALIBRE');
    });

    it('ne signale rien sous le seuil minimum de concentration', () => {
      const cases = detectCalibratedAmounts([c({ id: '1', estimatedAmount: 295_000 })], 300_000, 0.9, 3);
      expect(cases).toHaveLength(0);
    });

    it('ignore les montants hors bande (loin du plafond)', () => {
      const cases = detectCalibratedAmounts(
        [c({ id: '1', estimatedAmount: 50_000 }), c({ id: '2', estimatedAmount: 60_000 }), c({ id: '3', estimatedAmount: 70_000 })],
        300_000,
        0.9,
        3,
      );
      expect(cases).toHaveLength(0);
    });
  });

  describe('detectAbInconsistencies', () => {
    it('ne signale rien pour une paire cohérente', () => {
      const cases = detectAbInconsistencies([
        { claimAId: 'a', claimBId: 'b', companyA: 'CAAT', companyB: 'SAA', amountA: 100_000, amountB: 105_000, wilayaA: '16', wilayaB: '16', dateA: '2026-01-10', dateB: '2026-01-10' },
      ]);
      expect(cases).toHaveLength(0);
    });

    it('signale un écart de montant > 40%', () => {
      const cases = detectAbInconsistencies([
        { claimAId: 'a', claimBId: 'b', companyA: 'CAAT', companyB: 'SAA', amountA: 100_000, amountB: 200_000 },
      ]);
      expect(cases).toHaveLength(1);
      expect(cases[0].type).toBe('INCOHERENCE_AB');
      expect(cases[0].score).toBeGreaterThanOrEqual(50);
    });

    it('signale une wilaya discordante même avec des montants cohérents', () => {
      const cases = detectAbInconsistencies([
        { claimAId: 'a', claimBId: 'b', companyA: 'CAAT', companyB: 'SAA', amountA: 100_000, amountB: 100_000, wilayaA: '16', wilayaB: '31' },
      ]);
      expect(cases).toHaveLength(1);
      expect(cases[0].details.wilayaMismatch).toBe(true);
    });

    it('cumule les signaux (montant + wilaya + date) jusqu’à un plafond de 100', () => {
      const cases = detectAbInconsistencies([
        { claimAId: 'a', claimBId: 'b', companyA: 'CAAT', companyB: 'SAA', amountA: 50_000, amountB: 200_000, wilayaA: '16', wilayaB: '31', dateA: '2026-01-10', dateB: '2026-01-11' },
      ]);
      expect(cases[0].score).toBe(100);
    });
  });
});
