import { canAdvanceCaseStatus, isCompanyPartyToCase } from './commission.rules';

describe('canAdvanceCaseStatus', () => {
  it('autorise A_INSTRUIRE -> EN_DELIBERE', () => {
    expect(canAdvanceCaseStatus('A_INSTRUIRE', 'EN_DELIBERE')).toBe(true);
  });

  it('autorise EN_DELIBERE -> PRONONCE', () => {
    expect(canAdvanceCaseStatus('EN_DELIBERE', 'PRONONCE')).toBe(true);
  });

  it('interdit de sauter une étape (A_INSTRUIRE -> PRONONCE)', () => {
    expect(canAdvanceCaseStatus('A_INSTRUIRE', 'PRONONCE')).toBe(false);
  });

  it('interdit tout retour en arrière', () => {
    expect(canAdvanceCaseStatus('PRONONCE', 'EN_DELIBERE')).toBe(false);
    expect(canAdvanceCaseStatus('EN_DELIBERE', 'A_INSTRUIRE')).toBe(false);
  });

  it('interdit le statu quo (from === to)', () => {
    expect(canAdvanceCaseStatus('EN_DELIBERE', 'EN_DELIBERE')).toBe(false);
  });
});

describe('isCompanyPartyToCase', () => {
  it('accepte la compagnie A ou B', () => {
    expect(isCompanyPartyToCase('CAAT', 'CAAT', 'SAA')).toBe(true);
    expect(isCompanyPartyToCase('SAA', 'CAAT', 'SAA')).toBe(true);
  });

  it('rejette une compagnie tierce', () => {
    expect(isCompanyPartyToCase('CASH', 'CAAT', 'SAA')).toBe(false);
  });
});
