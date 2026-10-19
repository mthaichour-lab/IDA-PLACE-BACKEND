import { BadRequestException } from '@nestjs/common';
import { inflateRawSync } from 'zlib';

/**
 * SEC-12 — garde-fous du fichier d'import AVANT tout parsing (déni de
 * service). Implémentation maison, sans dépendance : lecture du répertoire
 * central du ZIP d'un XLSX (bombe zip, ratio de compression, taille
 * décompressée RÉELLE vérifiée par une décompression bornée), signature des
 * octets (un `.exe` renommé en `.xlsx` est refusé), `.xls` (OLE2) refusé
 * proprement, plafond de lignes.
 *
 * Toute violation lève une 400
 * avec un code lisible : le fichier entier est refusé, rien n'est persisté.
 *
 * Suite prévue hors de ce correctif : traitement asynchrone de l'import
 * dans une file de tâches (BullMQ sur Redis) avec rapport consultable —
 * le traitement reste ici synchrone, mais borné.
 */

export interface ImportLimits {
  /** Nombre maximal de lignes de données (hors en-tête) — `IMPORT_MAX_ROWS`, 5 000 par défaut. */
  maxRows: number;
  /** Taille cumulée maximale des entrées décompressées d'un XLSX — `IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES`, 50 Mo par défaut. */
  maxUncompressedBytes: number;
  /** Ratio de compression maximal par entrée (décompressé / compressé) — `IMPORT_XLSX_MAX_COMPRESSION_RATIO`, 100 par défaut. */
  maxCompressionRatio: number;
  /** Nombre maximal d'entrées dans l'archive — `IMPORT_XLSX_MAX_ENTRIES`, 500 par défaut. */
  maxZipEntries: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxRows: 5000,
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxZipEntries: 500,
};

function positiveIntFromEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    // Fermé par défaut : une configuration illisible ne doit pas lever le plafond.
    throw new Error(`${name} doit être un entier strictement positif (reçu "${raw}").`);
  }
  return n;
}

export function importLimitsFromEnv(env: Record<string, string | undefined> = process.env): ImportLimits {
  return {
    maxRows: positiveIntFromEnv(env.IMPORT_MAX_ROWS, DEFAULT_IMPORT_LIMITS.maxRows, 'IMPORT_MAX_ROWS'),
    maxUncompressedBytes: positiveIntFromEnv(env.IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES, DEFAULT_IMPORT_LIMITS.maxUncompressedBytes, 'IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES'),
    maxCompressionRatio: positiveIntFromEnv(env.IMPORT_XLSX_MAX_COMPRESSION_RATIO, DEFAULT_IMPORT_LIMITS.maxCompressionRatio, 'IMPORT_XLSX_MAX_COMPRESSION_RATIO'),
    maxZipEntries: positiveIntFromEnv(env.IMPORT_XLSX_MAX_ENTRIES, DEFAULT_IMPORT_LIMITS.maxZipEntries, 'IMPORT_XLSX_MAX_ENTRIES'),
  };
}

export type ImportFormat = 'csv' | 'xlsx';

const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** Signatures binaires qu'un CSV ne peut pas porter (archive, OLE2, PDF, exécutable Windows/ELF). */
const BINARY_MAGICS = [ZIP_LOCAL_HEADER, OLE2_MAGIC, Buffer.from('%PDF-'), Buffer.from('MZ'), Buffer.from([0x7f, 0x45, 0x4c, 0x46])];

function startsWith(buffer: Buffer, magic: Buffer): boolean {
  return buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic);
}

function invalid(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}

/**
 * Format réel du fichier : l'extension ET la signature des octets doivent
 * concorder. `.xls` (Excel 97-2003, OLE2) est refusé avec un message
 * explicite : le parseur ne lit que l'XLSX (Office Open XML) et le CSV.
 */
export function detectImportFormat(fileName: string, buffer: Buffer): ImportFormat {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'xls' || startsWith(buffer, OLE2_MAGIC)) {
    throw invalid('FORMAT_XLS_NON_PRIS_EN_CHARGE', 'Le format Excel 97-2003 (.xls) n’est pas pris en charge : enregistrez le fichier au format .xlsx ou .csv.');
  }
  if (ext === 'xlsx') {
    if (!startsWith(buffer, ZIP_LOCAL_HEADER)) {
      throw invalid('FORMAT_INVALIDE', 'Le contenu du fichier ne correspond pas à un classeur .xlsx.');
    }
    return 'xlsx';
  }
  if (ext === 'csv') {
    if (BINARY_MAGICS.some((m) => startsWith(buffer, m))) {
      throw invalid('FORMAT_INVALIDE', 'Le contenu du fichier ne correspond pas à un fichier texte .csv.');
    }
    // Un octet NUL n'apparaît dans aucun CSV texte (UTF-8 ou Windows-1252).
    if (buffer.subarray(0, 64 * 1024).includes(0)) {
      throw invalid('FORMAT_INVALIDE', 'Le fichier .csv contient des octets binaires.');
    }
    return 'csv';
  }
  throw invalid('FORMAT_INVALIDE', 'Formats acceptés : .csv et .xlsx.');
}

/** Refuse un nombre de lignes de données (hors en-tête) au-delà du plafond. */
export function assertRowCount(dataRows: number, limits: Pick<ImportLimits, 'maxRows'>): void {
  if (dataRows > limits.maxRows) {
    throw new BadRequestException({
      code: 'IMPORT_TROP_DE_LIGNES',
      message: `Le fichier contient trop de lignes : ${limits.maxRows} déclarations au maximum par import (découpez le fichier).`,
    });
  }
}

/** Compte les lignes non vides d'un CSV sans le parser (en-tête compris). */
export function countCsvLines(buffer: Buffer): number {
  let count = 0;
  let lineHasContent = false;
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    if (b === 0x0a || b === 0x0d) {
      if (lineHasContent) count++;
      lineHasContent = false;
    } else if (b !== 0x20 && b !== 0x09) {
      lineHasContent = true;
    }
  }
  if (lineHasContent) count++;
  return count;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export interface ZipEntryInfo {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * Lit le répertoire central d'un XLSX et vérifie, AVANT de confier le
 * fichier à exceljs (dont la décompression n'est pas bornée) :
 *  - archive bien formée, ni ZIP64 ni entrée chiffrée, méthodes 0/8 seulement ;
 *  - nombre d'entrées, taille décompressée cumulée et ratio de compression
 *    par entrée sous les plafonds ;
 *  - taille décompressée RÉELLE : chaque entrée est décompressée avec une
 *    sortie bornée à la taille déclarée (`maxOutputLength`), donc une
 *    archive qui ment sur ses tailles est refusée sans dépasser la mémoire
 *    fixée par `maxUncompressedBytes` ;
 *  - présence de `[Content_Types].xml` (signature Office Open XML).
 */
export function inspectXlsxArchive(buffer: Buffer, limits: ImportLimits): ZipEntryInfo[] {
  const bomb = (message: string) => invalid('ARCHIVE_REFUSEE', `Classeur .xlsx refusé : ${message}`);
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw invalid('FORMAT_INVALIDE', 'Classeur .xlsx illisible (répertoire central absent).');

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw bomb('archive ZIP64 non acceptée.');
  if (totalEntries === 0) throw invalid('FORMAT_INVALIDE', 'Classeur .xlsx vide.');
  if (totalEntries > limits.maxZipEntries) throw bomb(`trop d'entrées dans l'archive (${totalEntries}).`);
  if (cdOffset + cdSize > eocd) throw invalid('FORMAT_INVALIDE', 'Classeur .xlsx corrompu (répertoire central hors limites).');

  const entries: Array<ZipEntryInfo & { flags: number; localOffset: number }> = [];
  let cursor = cdOffset;
  let declaredTotal = 0;
  for (let n = 0; n < totalEntries; n++) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw invalid('FORMAT_INVALIDE', 'Classeur .xlsx corrompu (entrée du répertoire central invalide).');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf-8');
    cursor += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw bomb(`entrée chiffrée (${name}).`);
    if (method !== 0 && method !== 8) throw bomb(`méthode de compression non supportée (${method}).`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw bomb('archive ZIP64 non acceptée.');
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxCompressionRatio)) {
      throw bomb(`taux de compression anormal pour « ${name} ».`);
    }
    declaredTotal += uncompressedSize;
    if (declaredTotal > limits.maxUncompressedBytes) throw bomb('taille décompressée trop importante.');
    entries.push({ name, method, compressedSize, uncompressedSize, flags, localOffset });
  }

  if (!entries.some((e) => e.name === '[Content_Types].xml')) {
    throw invalid('FORMAT_INVALIDE', 'Le fichier n’est pas un classeur Office Open XML (.xlsx).');
  }

  for (const e of entries) {
    const lo = e.localOffset;
    if (lo + 30 > buffer.length || buffer.readUInt32LE(lo) !== LOCAL_SIGNATURE) {
      throw invalid('FORMAT_INVALIDE', 'Classeur .xlsx corrompu (en-tête local invalide).');
    }
    const start = lo + 30 + buffer.readUInt16LE(lo + 26) + buffer.readUInt16LE(lo + 28);
    const end = start + e.compressedSize;
    if (end > buffer.length) throw invalid('FORMAT_INVALIDE', 'Classeur .xlsx tronqué.');
    const data = buffer.subarray(start, end);
    if (e.method === 0) {
      if (e.compressedSize !== e.uncompressedSize) throw bomb(`taille incohérente pour « ${e.name} ».`);
      continue;
    }
    let inflated: Buffer;
    try {
      // Sortie bornée à la taille déclarée (+1 pour détecter un dépassement) :
      // une entrée qui ment sur sa taille lève ici, sans allouer au-delà.
      inflated = inflateRawSync(data, { maxOutputLength: e.uncompressedSize + 1 });
    } catch {
      throw bomb(`contenu compressé invalide ou plus volumineux que déclaré (« ${e.name} »).`);
    }
    if (inflated.length !== e.uncompressedSize) throw bomb(`taille décompressée incohérente pour « ${e.name} ».`);
  }

  return entries.map(({ name, method, compressedSize, uncompressedSize }) => ({ name, method, compressedSize, uncompressedSize }));
}

/** Point d'entrée unique : format réel, archive XLSX saine, plafond de lignes CSV (le plafond XLSX est vérifié pendant la lecture de la feuille). */
export function assertImportFileAcceptable(fileName: string, buffer: Buffer, limits: ImportLimits): ImportFormat {
  const format = detectImportFormat(fileName, buffer);
  if (format === 'xlsx') {
    inspectXlsxArchive(buffer, limits);
  } else {
    assertRowCount(Math.max(0, countCsvLines(buffer) - 1), limits);
  }
  return format;
}
