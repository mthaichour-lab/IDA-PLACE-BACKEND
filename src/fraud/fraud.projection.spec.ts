import { FraudCaseViewDto } from './dto/fraud.dto';
import { ClaimOwnership, projectFraudCase } from './fraud.projection';

const claims = new Map<string, ClaimOwnership>([
  ['c-caat', { company: 'CAAT', plateA: '16-111-16' }],
  ['c-saa', { company: 'SAA', plateA: '31-222-31' }],
  ['c-cash', { company: 'CASH', plateA: '09-333-09' }],
]);

const incoherence: FraudCaseViewDto = {
  id: 'f1',
  type: 'INCOHERENCE_AB',
  score: 75,
  severity: 'ELEVEE',
  claimIds: ['c-caat', 'c-saa'],
  companiesInvolved: ['CAAT', 'SAA'],
  details: { amountA: 120000, amountB: 280000, diffRatio: 0.571, wilayaMismatch: true, dateMismatch: false },
  detectedAt: '2026-10-19T00:00:00.000Z',
};

const recurrence: FraudCaseViewDto = {
  id: 'f2',
  type: 'RECURRENCE_VEHICULE',
  score: 60,
  severity: 'MOYENNE',
  claimIds: ['c-caat', 'c-saa', 'c-cash'],
  companiesInvolved: ['CAAT', 'SAA', 'CASH'],
  details: { plateA: '16-111-16', companiesCount: 3, windowDays: 90 },
  detectedAt: '2026-10-19T00:00:00.000Z',
};

describe('SEC-26 — projection des cas de fraude par compagnie', () => {
  it('CAAT ne reçoit que son dossier, son montant et le nombre de contreparties', () => {
    const out = projectFraudCase(incoherence, 'CAAT', claims);
    expect(out).toMatchObject({ claimIds: ['c-caat'], companiesInvolved: ['CAAT'], counterpartClaims: 1, counterpartCompanies: 1, plateA: '16-111-16' });
    expect(out.details).toEqual({ amountA: 120000, diffRatio: 0.571, wilayaMismatch: true, dateMismatch: false });
    expect(JSON.stringify(out)).not.toMatch(/c-saa|SAA|280000|31-222-31/);
  });

  it('SAA reçoit le montant de SON côté seulement', () => {
    expect(projectFraudCase(incoherence, 'SAA', claims).details).toEqual({ amountB: 280000, diffRatio: 0.571, wilayaMismatch: true, dateMismatch: false });
  });

  it('récurrence d’un véhicule : ni les dossiers ni les codes des concurrentes', () => {
    const out = projectFraudCase(recurrence, 'CASH', claims);
    expect(out).toMatchObject({ claimIds: ['c-cash'], companiesInvolved: ['CASH'], counterpartClaims: 2, counterpartCompanies: 2, plateA: '09-333-09' });
    expect(JSON.stringify(out)).not.toMatch(/c-caat|c-saa|"CAAT"|"SAA"/);
  });

  it('rôle place : cas complet', () => {
    const out = projectFraudCase(incoherence, undefined, claims);
    expect(out).toMatchObject({ claimIds: ['c-caat', 'c-saa'], companiesInvolved: ['CAAT', 'SAA'], details: incoherence.details });
    expect(out.counterpartClaims).toBeUndefined();
  });
});
