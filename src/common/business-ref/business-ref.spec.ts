import { BUSINESS_REF_PATTERN, businessRefPeriod, formatBusinessRef, MemoryBusinessRefCounter, nextBusinessRef } from './business-ref';

describe('Références métier (REC / CSC / MAT)', () => {
  it('formate chaque type avec sa largeur, sans jamais tronquer au-delà', () => {
    expect(formatBusinessRef('REC', '2026', 296)).toBe('REC-2026-00296');
    expect(formatBusinessRef('CSC', '2026', 11)).toBe('CSC-2026-011');
    expect(formatBusinessRef('MAT', '261013', 1)).toBe('MAT-261013-001');
    expect(formatBusinessRef('MAT', '261013', 1234)).toBe('MAT-261013-1234');
    expect(() => formatBusinessRef('REC', '2026', 0)).toThrow();
  });

  it('lit la période à l’heure d’Alger (UTC+1) : 31/12 23 h 30 UTC appartient déjà à l’année suivante', () => {
    const lateUtc = new Date('2026-12-31T23:30:00Z');
    expect(businessRefPeriod('REC', lateUtc)).toBe('2027');
    expect(businessRefPeriod('MAT', lateUtc)).toBe('270101');
    expect(businessRefPeriod('CSC', new Date('2026-12-31T22:59:00Z'))).toBe('2026');
    expect(businessRefPeriod('MAT', new Date('2026-10-13T08:00:00Z'))).toBe('261013');
  });

  it('le compteur mémoire numérote séquentiellement par (type, période) et repart à 1 à chaque période', () => {
    const counter = new MemoryBusinessRefCounter();
    const day1 = new Date('2026-10-13T08:00:00Z');
    const day2 = new Date('2026-10-14T08:00:00Z');
    expect([counter.next('MAT', day1), counter.next('MAT', day1), counter.next('MAT', day2)]).toEqual(['MAT-261013-001', 'MAT-261013-002', 'MAT-261014-001']);
    expect(counter.next('REC', day1)).toBe('REC-2026-00001');
    expect(counter.next('CSC', day2)).toBe('CSC-2026-001');
  });

  it('le motif reconnaît les trois formats et rien d’autre', () => {
    for (const ok of ['REC-2026-00296', 'CSC-2026-011', 'MAT-261013-001', 'MAT-261013-1001']) expect(ok).toMatch(BUSINESS_REF_PATTERN);
    for (const ko of ['REC-26-00296', 'CSC-2026-11', 'MAT-2610-001', '3f1c2b9e-0000-4000-8000-000000000000']) expect(ko).not.toMatch(BUSINESS_REF_PATTERN);
  });

  it('nextBusinessRef délègue à la fonction SQL, paramétrée (aucune concaténation)', async () => {
    const execute = jest.fn(async () => [{ ref: 'REC-2026-00007' }]);
    const at = new Date('2026-03-01T10:00:00Z');
    await expect(nextBusinessRef({ execute } as never, 'REC', at)).resolves.toBe('REC-2026-00007');
    expect(execute).toHaveBeenCalledWith('select next_business_ref(?, ?) as ref', ['REC', at.toISOString()]);
  });

  it('nextBusinessRef échoue explicitement si la base ne renvoie rien', async () => {
    await expect(nextBusinessRef({ execute: async () => [] } as never, 'CSC', new Date())).rejects.toThrow(/non attribuée/);
  });
});
