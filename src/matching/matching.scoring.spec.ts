import { ClaimMatchInput } from './matching.types';
import { computeMatchScore, levelForScore, MATCH_WEIGHTS } from './matching.scoring';

function claim(overrides: Partial<ClaimMatchInput> = {}): ClaimMatchInput {
  return {
    id: 'clm-a',
    numEconstat: undefined,
    company: 'CAAT',
    counterpartyCompany: 'SAA',
    plateA: '16-100000-16',
    plateB: '31-200000-31',
    policeA: 'POL-A-1',
    policeB: 'POL-B-1',
    accidentDate: '2026-01-10',
    accidentTime: '10:00',
    wilaya: '16',
    commune: 'Alger-Centre',
    gpsLat: 36.75,
    gpsLng: 3.06,
    ...overrides,
  };
}

describe('computeMatchScore (B.5)', () => {
  it('score 100 et clé EXACTE quand le n° e-constat est partagé', () => {
    const a = claim({ numEconstat: 'ECT-2026-1' });
    const b = claim({ id: 'clm-b', numEconstat: 'ECT-2026-1', plateA: 'XX', plateB: 'YY' });
    const result = computeMatchScore(a, b);
    expect(result.score).toBe(100);
    expect(result.econstatShared).toBe(true);
    expect(result.key).toBe('EXACTE');
  });

  it('plaques croisées : {A,B} == {B,A} compte comme la même paire non ordonnée', () => {
    const a = claim({ plateA: 'P1', plateB: 'P2' });
    const b = claim({ id: 'clm-b', plateA: 'P2', plateB: 'P1', accidentDate: undefined, policeA: undefined, policeB: undefined, gpsLat: undefined, gpsLng: undefined, counterpartyCompany: undefined });
    const result = computeMatchScore(a, b);
    expect(result.criteria.plaquesCroisees).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(MATCH_WEIGHTS.plaquesCroisees);
  });

  it('les plaques dans le même ordre {A,B} == {A,B} comptent aussi comme correspondance', () => {
    const a = claim({ plateA: 'P1', plateB: 'P2' });
    const b = claim({ id: 'clm-b', plateA: 'P1', plateB: 'P2' });
    const result = computeMatchScore(a, b);
    expect(result.criteria.plaquesCroisees).toBe(true);
  });

  it('la normalisation ignore espaces/tirets/casse sur les plaques', () => {
    const a = claim({ plateA: '16-100000-16', plateB: '31 200000 31' });
    const b = claim({ id: 'clm-b', plateA: '16100000 16', plateB: '31-200000-31' });
    const result = computeMatchScore(a, b);
    expect(result.criteria.plaquesCroisees).toBe(true);
  });

  it('pas de correspondance plaques si une seule plaque est fournie de chaque côté', () => {
    const a = claim({ plateA: 'P1', plateB: undefined });
    const b = claim({ id: 'clm-b', plateA: 'P1', plateB: undefined });
    const result = computeMatchScore(a, b);
    expect(result.criteria.plaquesCroisees).toBe(false);
  });

  it('police/attestation croisée : policeA de A == policeB de B', () => {
    const a = claim({ policeA: 'SAME', policeB: 'OTHER-A', plateA: 'X1', plateB: 'X2' });
    const b = claim({ id: 'clm-b', policeA: 'OTHER-B', policeB: 'SAME', plateA: 'Y1', plateB: 'Y2', accidentDate: undefined, gpsLat: undefined, gpsLng: undefined, counterpartyCompany: undefined });
    const result = computeMatchScore(a, b);
    expect(result.criteria.policeCroisee).toBe(true);
  });

  it('date/heure : correspond si écart ≤ 60 minutes (cas limite)', () => {
    const a = claim({ accidentDate: '2026-01-10', accidentTime: '10:00' });
    const b = claim({ id: 'clm-b', accidentDate: '2026-01-10', accidentTime: '11:00', plateA: undefined, plateB: undefined, policeA: undefined, policeB: undefined, gpsLat: undefined, gpsLng: undefined, counterpartyCompany: undefined });
    const result = computeMatchScore(a, b);
    expect(result.criteria.dateHeure).toBe(true);
  });

  it('date/heure : ne correspond pas au-delà de 60 minutes (cas limite)', () => {
    const a = claim({ accidentDate: '2026-01-10', accidentTime: '10:00' });
    const b = claim({ id: 'clm-b', accidentDate: '2026-01-10', accidentTime: '11:01', plateA: undefined, plateB: undefined, policeA: undefined, policeB: undefined, gpsLat: undefined, gpsLng: undefined, counterpartyCompany: undefined });
    const result = computeMatchScore(a, b);
    expect(result.criteria.dateHeure).toBe(false);
  });

  it('date seule (sans heure) : tolère ± 2 jours', () => {
    const a = claim({ accidentDate: '2026-01-10', accidentTime: undefined });
    const b = claim({ id: 'clm-b', accidentDate: '2026-01-12', accidentTime: undefined, plateA: undefined, plateB: undefined, policeA: undefined, policeB: undefined, gpsLat: undefined, gpsLng: undefined, counterpartyCompany: undefined });
    const result = computeMatchScore(a, b);
    expect(result.criteria.dateHeure).toBe(true);
  });

  it('date seule : rejette un écart de 3 jours', () => {
    const a = claim({ accidentDate: '2026-01-10', accidentTime: undefined });
    const b = claim({ id: 'clm-b', accidentDate: '2026-01-13', accidentTime: undefined, plateA: undefined, plateB: undefined, policeA: undefined, policeB: undefined, gpsLat: undefined, gpsLng: undefined, counterpartyCompany: undefined });
    const result = computeMatchScore(a, b);
    expect(result.criteria.dateHeure).toBe(false);
  });

  it('compagnies croisées : A.company==B.counterparty et B.company==A.counterparty', () => {
    const a = claim({ company: 'CAAT', counterpartyCompany: 'SAA' });
    const b = claim({ id: 'clm-b', company: 'SAA', counterpartyCompany: 'CAAT', plateA: undefined, plateB: undefined, policeA: undefined, policeB: undefined, accidentDate: undefined, gpsLat: undefined, gpsLng: undefined });
    const result = computeMatchScore(a, b);
    expect(result.criteria.compagniesCroisees).toBe(true);
  });

  it('GPS : correspond sous le seuil de tolérance (2 km)', () => {
    const a = claim({ gpsLat: 36.75, gpsLng: 3.06, plateA: undefined, plateB: undefined, policeA: undefined, policeB: undefined, accidentDate: undefined, counterpartyCompany: undefined });
    const b = claim({ id: 'clm-b', gpsLat: 36.76, gpsLng: 3.06, plateA: undefined, plateB: undefined, policeA: undefined, policeB: undefined, accidentDate: undefined, counterpartyCompany: undefined });
    const result = computeMatchScore(a, b);
    expect(result.criteria.gps).toBe(true);
  });

  it('GPS : ne correspond pas au-delà du seuil de tolérance', () => {
    const a = claim({ gpsLat: 36.75, gpsLng: 3.06, plateA: undefined, plateB: undefined, policeA: undefined, policeB: undefined, accidentDate: undefined, counterpartyCompany: undefined });
    const b = claim({ id: 'clm-b', gpsLat: 36.95, gpsLng: 3.3, plateA: undefined, plateB: undefined, policeA: undefined, policeB: undefined, accidentDate: undefined, counterpartyCompany: undefined });
    const result = computeMatchScore(a, b);
    expect(result.criteria.gps).toBe(false);
  });

  it('cumule correctement les poids (plaques 35 + police 15 + date-heure 15 + compagnies 10 + gps 10 = 85)', () => {
    const a = claim();
    const b = claim({ id: 'clm-b', plateA: '31-200000-31', plateB: '16-100000-16', policeA: 'POL-B-1', policeB: 'POL-A-1', company: 'SAA', counterpartyCompany: 'CAAT' });
    const result = computeMatchScore(a, b);
    expect(result.score).toBe(85);
    expect(result.key).toBe('COMPOSITE');
  });

  it('renvoie un score de 0 et la clé AUCUNE quand rien ne correspond', () => {
    const a = claim({ plateA: 'A1', plateB: 'A2', policeA: 'PA', policeB: 'PB', accidentDate: '2026-01-01', accidentTime: '08:00', gpsLat: 10, gpsLng: 10, company: 'CAAT', counterpartyCompany: 'SAA' });
    const b = claim({ id: 'clm-b', plateA: 'B1', plateB: 'B2', policeA: 'PC', policeB: 'PD', accidentDate: '2026-06-01', accidentTime: '08:00', gpsLat: 40, gpsLng: 40, company: 'CASH', counterpartyCompany: 'ALLI' });
    const result = computeMatchScore(a, b);
    expect(result.score).toBe(0);
    expect(result.key).toBe('AUCUNE');
  });
});

describe('levelForScore', () => {
  const thresholds = { autoThreshold: 80, confirmThreshold: 50 };

  it('AUTO au-dessus (ou égal) du seuil auto (cas limite)', () => {
    expect(levelForScore(80, thresholds)).toBe('AUTO');
    expect(levelForScore(100, thresholds)).toBe('AUTO');
  });

  it('MANUEL entre les deux seuils (cas limite basse)', () => {
    expect(levelForScore(50, thresholds)).toBe('MANUEL');
    expect(levelForScore(79, thresholds)).toBe('MANUEL');
  });

  it('NON sous le seuil de confirmation (cas limite)', () => {
    expect(levelForScore(49, thresholds)).toBe('NON');
    expect(levelForScore(0, thresholds)).toBe('NON');
  });
});
