import { Logger } from '@nestjs/common';
import { sanitizeForLog } from './sanitize-log';

const ESC = String.fromCharCode(0x1b);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

/** SEC-45 — neutralisation des valeurs journalisées. */
describe('sanitizeForLog (SEC-45)', () => {
  it('échappe retours à la ligne, tabulations et séquences terminal : une seule ligne', () => {
    const out = sanitizeForLog(`ADMIN\n2026-10-19 [Nest] LOG faux message\r\t${ESC}[31m`);
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\r');
    expect(out).not.toContain(ESC);
    expect(out).toContain('\\n');
    expect(out).toContain('\\u001b');
  });

  it('échappe les séparateurs de ligne Unicode', () => {
    expect(sanitizeForLog(`a${LINE_SEPARATOR}b`)).toBe('a\\u2028b');
  });

  it('tronque les valeurs longues', () => {
    const out = sanitizeForLog('x'.repeat(1000), 50);
    expect(out.startsWith('x'.repeat(50))).toBe(true);
    expect(out).toMatch(/tronqué 950 car\./);
  });

  it('accepte erreurs et objets', () => {
    expect(sanitizeForLog(new Error('boom\nfin'))).toBe('boom\\nfin');
    expect(sanitizeForLog({ a: 1 })).toBe('{"a":1}');
  });

  it('un en-tête contenant \\n produit une seule ligne de journal', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    new Logger('Test').warn(`valeur: ${sanitizeForLog('a\nb\nc')}`);
    expect(String(warn.mock.calls[0][0]).split('\n')).toHaveLength(1);
    warn.mockRestore();
  });
});
