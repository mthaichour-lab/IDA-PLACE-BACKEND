import { computeWithdrawalEffectiveDate, isIsoCalendarDate, isWithdrawalEffectiveReached, nextMembershipState } from './membership.rules';

describe('Adhésions et retraits — règles pures (Art. 30-35)', () => {
  describe('computeWithdrawalEffectiveDate (préavis ≥ 3 mois avant la fin de l’année civile)', () => {
    it.each([
      ['2026-01-01', '2026-12-31'],
      ['2026-09-30', '2026-12-31'],
      ['2026-10-01', '2027-12-31'],
      ['2026-12-31', '2027-12-31'],
      ['2028-02-29', '2028-12-31'],
    ])('reçu le %s -> effet au %s', (receivedAt, expected) => {
      expect(computeWithdrawalEffectiveDate(receivedAt)).toBe(expected);
    });

    it('rejette une date invalide', () => {
      expect(() => computeWithdrawalEffectiveDate('2026-02-30')).toThrow();
      expect(() => computeWithdrawalEffectiveDate('30/09/2026')).toThrow();
    });
  });

  it('isIsoCalendarDate n’accepte que des dates calendaires réelles', () => {
    expect(isIsoCalendarDate('2026-09-30')).toBe(true);
    expect(isIsoCalendarDate('2026-09-31')).toBe(false);
    expect(isIsoCalendarDate('2026-9-30')).toBe(false);
  });

  it('le retrait n’est constatable que strictement après la date d’effet', () => {
    expect(isWithdrawalEffectiveReached('2026-12-31', new Date('2026-12-31T23:59:59Z'))).toBe(false);
    expect(isWithdrawalEffectiveReached('2026-12-31', new Date('2027-01-01T00:00:00Z'))).toBe(true);
  });

  describe('machine d’état', () => {
    it('ADHESION : RECUE -> ACCEPTEE | REJETEE, ni effet ni annulation', () => {
      expect(nextMembershipState('ADHESION', 'RECUE', 'accept')).toBe('ACCEPTEE');
      expect(nextMembershipState('ADHESION', 'RECUE', 'reject')).toBe('REJETEE');
      expect(nextMembershipState('ADHESION', 'RECUE', 'effective')).toBeUndefined();
      expect(nextMembershipState('ADHESION', 'RECUE', 'cancel')).toBeUndefined();
    });

    it('RETRAIT : RECUE -> EFFECTIVE | ANNULEE, jamais de rejet (droit unilatéral)', () => {
      expect(nextMembershipState('RETRAIT', 'RECUE', 'effective')).toBe('EFFECTIVE');
      expect(nextMembershipState('RETRAIT', 'RECUE', 'cancel')).toBe('ANNULEE');
      expect(nextMembershipState('RETRAIT', 'RECUE', 'reject')).toBeUndefined();
      expect(nextMembershipState('RETRAIT', 'RECUE', 'accept')).toBeUndefined();
    });

    it('aucune transition depuis un état final', () => {
      expect(nextMembershipState('ADHESION', 'ACCEPTEE', 'reject')).toBeUndefined();
      expect(nextMembershipState('ADHESION', 'REJETEE', 'accept')).toBeUndefined();
      expect(nextMembershipState('RETRAIT', 'EFFECTIVE', 'cancel')).toBeUndefined();
      expect(nextMembershipState('RETRAIT', 'ANNULEE', 'effective')).toBeUndefined();
    });
  });
});
