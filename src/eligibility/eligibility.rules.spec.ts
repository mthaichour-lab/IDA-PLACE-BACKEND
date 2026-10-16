import { addMonthsUtc, DEFAULT_ELIGIBILITY_CONFIG, EligibilityInputRow, evaluateEligibility } from './eligibility.rules';

/** Ligne "idéale" satisfaisant toutes les règles B.6 — base pour les tests de cas limites. */
function eligibleRow(overrides: Partial<EligibilityInputRow> = {}): EligibilityInputRow {
  return {
    nombreVehicules: 2,
    territoire: 'ALGERIE',
    dommagesCorporelsDeclares: false,
    adversePartieAdherente: true,
    adversePartieActive: true,
    montantEstime: 150_000,
    montantExpertise: 140_000,
    dateAccident: '2026-01-10',
    dateDemandeRecours: '2026-02-01',
    exclusions: [],
    piecesFournies: ['CONSTAT_AMIABLE', 'CARTE_GRISE', 'PERMIS_CONDUIRE', 'ATTESTATION_ASSURANCE'],
    constatAmiableSigneDeuxParties: true,
    ...overrides,
  };
}

describe('evaluateEligibility (B.6)', () => {
  it('déclare éligible un dossier qui satisfait toutes les règles', () => {
    const verdict = evaluateEligibility(eligibleRow());
    expect(verdict.verdict).toBe('ELIGIBLE_IDA');
    expect(verdict.reasons).toHaveLength(0);
  });

  it('rejette un dossier à 1 véhicule (Art. 4)', () => {
    const verdict = evaluateEligibility(eligibleRow({ nombreVehicules: 1 }));
    expect(verdict.verdict).toBe('HORS_IDA');
    expect(verdict.reasons.some((r) => r.includes('Art. 4'))).toBe(true);
  });

  it('rejette un dossier à 3 véhicules impliqués (Art. 4)', () => {
    const verdict = evaluateEligibility(eligibleRow({ nombreVehicules: 3 }));
    expect(verdict.verdict).toBe('HORS_IDA');
  });

  it('rejette un dossier avec dommages corporels déclarés (Art. 3)', () => {
    const verdict = evaluateEligibility(eligibleRow({ dommagesCorporelsDeclares: true }));
    expect(verdict.verdict).toBe('HORS_IDA');
    expect(verdict.reasons.some((r) => r.includes('Art. 3'))).toBe(true);
  });

  it('rejette un accident hors territoire algérien (Art. 3)', () => {
    const verdict = evaluateEligibility(eligibleRow({ territoire: 'ETRANGER' }));
    expect(verdict.verdict).toBe('HORS_IDA');
  });

  it('rejette si la partie adverse n’est pas adhérente IDA (Art. 3/28)', () => {
    const verdict = evaluateEligibility(eligibleRow({ adversePartieAdherente: false }));
    expect(verdict.verdict).toBe('HORS_IDA');
    expect(verdict.reasons.some((r) => r.includes('Art. 3/28'))).toBe(true);
  });

  it('rejette si la partie adverse n’est pas active (Art. 28)', () => {
    const verdict = evaluateEligibility(eligibleRow({ adversePartieActive: false }));
    expect(verdict.verdict).toBe('HORS_IDA');
    expect(verdict.reasons.some((r) => r.includes('Art. 28'))).toBe(true);
  });

  it('accepte un montant exactement égal au plafond (cas limite, Art. 4)', () => {
    const verdict = evaluateEligibility(
      eligibleRow({ montantExpertise: DEFAULT_ELIGIBILITY_CONFIG.maxAmountDA, montantEstime: DEFAULT_ELIGIBILITY_CONFIG.maxAmountDA }),
    );
    expect(verdict.verdict).toBe('ELIGIBLE_IDA');
  });

  it('rejette un montant dépassant le plafond de 1 DA (cas limite, Art. 4)', () => {
    const verdict = evaluateEligibility(
      eligibleRow({ montantExpertise: DEFAULT_ELIGIBILITY_CONFIG.maxAmountDA + 1, montantEstime: DEFAULT_ELIGIBILITY_CONFIG.maxAmountDA + 1 }),
    );
    expect(verdict.verdict).toBe('HORS_IDA');
    expect(verdict.reasons.some((r) => r.includes('plafond'))).toBe(true);
  });

  it('retient le montant expertisé plutôt que le montant estimé quand les deux sont fournis', () => {
    // Estimé au-dessus du plafond, expertisé en-dessous : doit rester éligible.
    const verdict = evaluateEligibility(eligibleRow({ montantEstime: 500_000, montantExpertise: 100_000 }));
    expect(verdict.verdict).toBe('ELIGIBLE_IDA');
  });

  it('rejette un montant totalement absent (Art. 4)', () => {
    const verdict = evaluateEligibility(eligibleRow({ montantEstime: undefined, montantExpertise: undefined }));
    expect(verdict.verdict).toBe('HORS_IDA');
  });

  it('accepte un recours introduit exactement à la date d’échéance des 6 mois (cas limite, Art. 19)', () => {
    const accident = '2026-01-10';
    const deadline = addMonthsUtc(new Date(accident), 6).toISOString().slice(0, 10);
    const verdict = evaluateEligibility(eligibleRow({ dateAccident: accident, dateDemandeRecours: deadline }));
    expect(verdict.verdict).toBe('ELIGIBLE_IDA');
  });

  it('rejette (forclusion) un recours introduit un jour après l’échéance des 6 mois (Art. 19)', () => {
    const accident = '2026-01-10';
    const deadline = addMonthsUtc(new Date(accident), 6);
    const oneDayAfter = new Date(deadline.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const verdict = evaluateEligibility(eligibleRow({ dateAccident: accident, dateDemandeRecours: oneDayAfter }));
    expect(verdict.verdict).toBe('HORS_IDA');
    expect(verdict.reasons.some((r) => r.includes('forclusion') || r.includes('Art. 19'))).toBe(true);
  });

  it('rejette si la date de demande de recours est absente (Art. 19)', () => {
    const verdict = evaluateEligibility(eligibleRow({ dateDemandeRecours: undefined }));
    expect(verdict.verdict).toBe('HORS_IDA');
  });

  it('rejette si une exclusion contractuelle est déclarée (Art. 5-6)', () => {
    const verdict = evaluateEligibility(eligibleRow({ exclusions: ['CONDUITE_SANS_PERMIS'] }));
    expect(verdict.verdict).toBe('HORS_IDA');
    expect(verdict.reasons.some((r) => r.includes('Art. 5-6'))).toBe(true);
  });

  it('rejette si une pièce obligatoire manque (Art. 13)', () => {
    const verdict = evaluateEligibility(eligibleRow({ piecesFournies: ['CONSTAT_AMIABLE'] }));
    expect(verdict.verdict).toBe('HORS_IDA');
    expect(verdict.reasons.some((r) => r.includes('Art. 13'))).toBe(true);
  });

  it('accepte les pièces fournies indépendamment de la casse/espacement (Art. 13)', () => {
    const verdict = evaluateEligibility(
      eligibleRow({ piecesFournies: ['constat amiable', 'Carte Grise', 'permis_conduire', 'attestation assurance'] }),
    );
    expect(verdict.verdict).toBe('ELIGIBLE_IDA');
  });

  it('rejette si le constat amiable n’est pas signé par les deux parties (Art. 13)', () => {
    const verdict = evaluateEligibility(eligibleRow({ constatAmiableSigneDeuxParties: false }));
    expect(verdict.verdict).toBe('HORS_IDA');
  });

  it('cumule plusieurs motifs quand plusieurs règles sont violées', () => {
    const verdict = evaluateEligibility(
      eligibleRow({ nombreVehicules: 4, territoire: 'ETRANGER', exclusions: ['X'] }),
    );
    expect(verdict.verdict).toBe('HORS_IDA');
    expect(verdict.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
