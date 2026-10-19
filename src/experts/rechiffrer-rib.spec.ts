import { randomBytes } from 'crypto';
import { decryptRib, isLegacyPlainRib, planLegacyRibReencryption } from './rib-cipher';

/** SEC-49 — rechiffrement des RIB hérités (procédure de docs/DEPLOIEMENT.md). */
describe('planLegacyRibReencryption', () => {
  const key = randomBytes(32);

  it('chiffre les seuls RIB en clair, idempotent sur les enveloppes v1 et les valeurs vides', () => {
    const plan = planLegacyRibReencryption(
      [
        { id: 'a', rib: ' 00799999000123456789 ' },
        { id: 'b', rib: 'v1:deja:chiffre:xx' },
        { id: 'c', rib: null },
        { id: 'd', rib: '   ' },
      ],
      key,
    );
    expect(plan.map((p) => p.id)).toEqual(['a']);
    expect(plan[0].rib.startsWith('v1:')).toBe(true);
    expect(plan[0].ribLast4).toBe('6789');
    expect(decryptRib(plan[0].rib, key)).toBe('00799999000123456789');
    expect(isLegacyPlainRib(plan[0].rib)).toBe(false);
  });
});
