import * as ExcelJS from 'exceljs';
import { deflateRawSync } from 'zlib';
import { CLAIM_IMPORT_COLUMNS } from './claim-47-columns';
import { parseClaimFile } from './claim-parser';
import {
  assertImportFileAcceptable,
  countCsvLines,
  DEFAULT_IMPORT_LIMITS,
  detectImportFormat,
  importLimitsFromEnv,
  inspectXlsxArchive,
} from './import-file-guard';

interface ZipEntrySpec {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  /** Taille décompressée DÉCLARÉE (par défaut la vraie) — permet de fabriquer une archive menteuse. */
  declaredSize?: number;
  flags?: number;
}

/** Fabrique une archive ZIP minimale (en-têtes locaux + répertoire central + EOCD), sans CRC (non vérifié par le garde-fou). */
function buildZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const comp = method === 8 ? deflateRawSync(e.data) : e.data;
    const size = e.declaredSize ?? e.data.length;
    const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.flags ?? 0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.flags ?? 0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CONTENT_TYPES = { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>') };

async function realXlsx(dataRows: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Import');
  ws.addRow(CLAIM_IMPORT_COLUMNS.map((c) => c.label));
  for (let i = 0; i < dataRows; i++) {
    ws.addRow(CLAIM_IMPORT_COLUMNS.map((c) => (c.key === 'numEconstat' ? `XL-${i}` : c.key === 'compagnieA' ? 'CAAT' : '')));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as { getStatus?: () => number }).getStatus?.()).toBe(400);
    expect((err as { getResponse: () => { code: string } }).getResponse().code).toBe(code);
    return;
  }
  throw new Error(`exception ${code} attendue`);
}

describe('SEC-12 — garde-fous du fichier d’import', () => {
  describe('signature des octets et extension', () => {
    it('refuse proprement un .xls (Excel 97-2003) avec un code explicite', () => {
      expectCode(() => detectImportFormat('ancien.xls', Buffer.from('n’importe quoi')), 'FORMAT_XLS_NON_PRIS_EN_CHARGE');
      const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
      expectCode(() => detectImportFormat('deguise.xlsx', ole2), 'FORMAT_XLS_NON_PRIS_EN_CHARGE');
    });

    it('refuse un faux XLSX (texte renommé) et un exécutable renommé en .csv', () => {
      expectCode(() => detectImportFormat('faux.xlsx', Buffer.from('a;b;c\n1;2;3\n')), 'FORMAT_INVALIDE');
      expectCode(() => detectImportFormat('malware.csv', Buffer.from('MZ\x90\x00binaire')), 'FORMAT_INVALIDE');
      expectCode(() => detectImportFormat('archive.csv', buildZip([CONTENT_TYPES])), 'FORMAT_INVALIDE');
      expectCode(() => detectImportFormat('nul.csv', Buffer.from([0x61, 0x3b, 0x00, 0x62])), 'FORMAT_INVALIDE');
      expectCode(() => detectImportFormat('fichier.pdf', Buffer.from('%PDF-1.4')), 'FORMAT_INVALIDE');
    });

    it('accepte un vrai CSV et un vrai XLSX', async () => {
      expect(detectImportFormat('ok.csv', Buffer.from('a;b\n1;2\n'))).toBe('csv');
      expect(detectImportFormat('ok.xlsx', await realXlsx(2))).toBe('xlsx');
    });
  });

  describe('archive XLSX (bombe zip)', () => {
    it('un classeur produit par Excel/exceljs passe l’inspection', async () => {
      const entries = inspectXlsxArchive(await realXlsx(3), DEFAULT_IMPORT_LIMITS);
      expect(entries.some((e) => e.name === '[Content_Types].xml')).toBe(true);
    });

    it('refuse une bombe zip (ratio de compression anormal) sans la décompresser', () => {
      const bomb = buildZip([CONTENT_TYPES, { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(20 * 1024 * 1024) }]);
      expect(bomb.length).toBeLessThan(100 * 1024);
      expectCode(() => inspectXlsxArchive(bomb, DEFAULT_IMPORT_LIMITS), 'ARCHIVE_REFUSEE');
    });

    it('refuse une archive qui ment sur sa taille décompressée (décompression bornée)', () => {
      const liar = buildZip([CONTENT_TYPES, { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(2 * 1024 * 1024, 0x41), declaredSize: 4096 }]);
      expectCode(() => inspectXlsxArchive(liar, DEFAULT_IMPORT_LIMITS), 'ARCHIVE_REFUSEE');
    });

    it('refuse une taille décompressée cumulée au-delà du plafond', () => {
      const big = buildZip([CONTENT_TYPES, { name: 'xl/a.xml', data: Buffer.alloc(5000, 0x41), method: 0 }]);
      expectCode(() => inspectXlsxArchive(big, { ...DEFAULT_IMPORT_LIMITS, maxUncompressedBytes: 1000 }), 'ARCHIVE_REFUSEE');
    });

    it('refuse trop d’entrées, une entrée chiffrée, et une archive sans [Content_Types].xml', () => {
      const many = buildZip([CONTENT_TYPES, ...Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.xml`, data: Buffer.from('<x/>'), method: 0 as const }))]);
      expectCode(() => inspectXlsxArchive(many, { ...DEFAULT_IMPORT_LIMITS, maxZipEntries: 3 }), 'ARCHIVE_REFUSEE');
      const encrypted = buildZip([CONTENT_TYPES, { name: 'xl/a.xml', data: Buffer.from('<x/>'), method: 0, flags: 1 }]);
      expectCode(() => inspectXlsxArchive(encrypted, DEFAULT_IMPORT_LIMITS), 'ARCHIVE_REFUSEE');
      const notOoxml = buildZip([{ name: 'readme.txt', data: Buffer.from('hello'), method: 0 }]);
      expectCode(() => inspectXlsxArchive(notOoxml, DEFAULT_IMPORT_LIMITS), 'FORMAT_INVALIDE');
    });

    it('refuse une archive tronquée ou sans répertoire central', () => {
      expectCode(() => inspectXlsxArchive(Buffer.from('PK\x03\x04 tronqué'), DEFAULT_IMPORT_LIMITS), 'FORMAT_INVALIDE');
    });
  });

  describe('plafond de lignes', () => {
    it('compte les lignes non vides d’un CSV (CRLF, LF, lignes blanches)', () => {
      expect(countCsvLines(Buffer.from('h\r\n1\r\n\r\n2\n  \n3'))).toBe(4);
    });

    it('un CSV de 100 000 lignes est refusé avec le plafond par défaut (5 000)', () => {
      const csv = Buffer.from(`entete\n${'x;y\n'.repeat(100_000)}`);
      expectCode(() => assertImportFileAcceptable('enorme.csv', csv, DEFAULT_IMPORT_LIMITS), 'IMPORT_TROP_DE_LIGNES');
      expect(() => assertImportFileAcceptable('juste.csv', Buffer.from(`entete\n${'x;y\n'.repeat(5000)}`), DEFAULT_IMPORT_LIMITS)).not.toThrow();
    });

    it('un XLSX au-delà du plafond est refusé avant toute ligne traitée', async () => {
      const xlsx = await realXlsx(12);
      await expect(parseClaimFile(xlsx, 'trop.xlsx', { ...DEFAULT_IMPORT_LIMITS, maxRows: 10 })).rejects.toMatchObject({ response: { code: 'IMPORT_TROP_DE_LIGNES' } });
      await expect(parseClaimFile(xlsx, 'ok.xlsx', { ...DEFAULT_IMPORT_LIMITS, maxRows: 12 })).resolves.toHaveLength(12);
    });

    it('parseClaimFile refuse un faux XLSX (400) au lieu de le confier à exceljs', async () => {
      await expect(parseClaimFile(Buffer.from('pas un classeur'), 'faux.xlsx')).rejects.toMatchObject({ response: { code: 'FORMAT_INVALIDE' } });
    });
  });

  describe('configuration', () => {
    it('lit les plafonds de l’environnement, 5 000 lignes par défaut', () => {
      expect(importLimitsFromEnv({}).maxRows).toBe(5000);
      expect(importLimitsFromEnv({ IMPORT_MAX_ROWS: '200' }).maxRows).toBe(200);
    });

    it('refuse une valeur illisible plutôt que de lever le plafond (fermé par défaut)', () => {
      expect(() => importLimitsFromEnv({ IMPORT_MAX_ROWS: 'illimité' })).toThrow(/IMPORT_MAX_ROWS/);
      expect(() => importLimitsFromEnv({ IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES: '-1' })).toThrow();
    });
  });
});
