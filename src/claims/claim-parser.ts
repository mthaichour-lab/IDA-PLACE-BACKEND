import * as ExcelJS from 'exceljs';
import { CLAIM_IMPORT_COLUMNS, ClaimColumnDef } from './claim-47-columns';

/**
 * Parsing du fichier d'import (47 colonnes, B.4) — Excel (.xlsx/.xls) ou
 * CSV. Choix de librairie : **exceljs** pour le format Excel (installable
 * dans cet environnement, voir HANDOFF.md) ; un **parseur CSV maison**
 * (ci-dessous, `splitCsvLine`) pour le format CSV plutôt qu'une dépendance
 * supplémentaire — le format est simple (une ligne = une déclaration,
 * valeurs séparées par `,` ou `;`, guillemets optionnels pour échapper le
 * séparateur) et un parseur dédié de quelques lignes, testé, est largement
 * suffisant et plus facile à auditer qu'une dépendance de plus.
 *
 * Convention : la **première ligne est l'en-tête** (ignorée pour le
 * mapping, qui se fait par POSITION de colonne — le modèle téléchargeable,
 * B.4, impose un ordre de colonnes fixe, `CLAIM_IMPORT_COLUMNS`). Toute
 * ligne dont le nombre de cellules ne correspond pas est acceptée quand
 * même (cellules manquantes ⇒ valeurs absentes, pas une erreur bloquante :
 * c'est à `EligibilityModule` de juger si une donnée manquante rend le
 * dossier inéligible).
 */

export interface ParsedClaimRow {
  rowNumber: number; // 1-based, hors en-tête
  /** Valeurs typées, indexées par `key` de `CLAIM_IMPORT_COLUMNS`. */
  values: Record<string, unknown>;
  /** Erreurs de format/type rencontrées sur cette ligne (vide si aucune). */
  errors: string[];
}

export type ParsedFileFormat = 'xlsx' | 'csv';

export function detectFormat(fileName: string): ParsedFileFormat {
  const ext = fileName.toLowerCase().split('.').pop();
  return ext === 'csv' || ext === 'txt' ? 'csv' : 'xlsx';
}

/** Découpe une ligne CSV en champs, en gérant les guillemets (échappement `""`) et `,`/`;`. */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function detectDelimiter(headerLine: string): string {
  const commas = headerLine.split(',').length;
  const semicolons = headerLine.split(';').length;
  return semicolons > commas ? ';' : ',';
}

function parseCsvBuffer(buffer: Buffer): string[][] {
  const text = buffer.toString('utf-8').replace(/^﻿/, ''); // tolère un BOM UTF-8
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const delimiter = detectDelimiter(lines[0]);
  return lines.map((l) => splitCsvLine(l, delimiter));
}

async function parseXlsxBuffer(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const rows: string[][] = [];
  sheet.eachRow((row) => {
    const values: string[] = [];
    // `row.values[0]` est toujours vide (ExcelJS indexe les cellules à partir de 1).
    const cellCount = Math.max(row.cellCount, CLAIM_IMPORT_COLUMNS.length);
    for (let c = 1; c <= cellCount; c++) {
      const cell = row.getCell(c);
      const v = cell.value;
      if (v === null || v === undefined) {
        values.push('');
      } else if (v instanceof Date) {
        values.push(v.toISOString().slice(0, 10));
      } else if (typeof v === 'object' && 'text' in (v as unknown as Record<string, unknown>)) {
        values.push(String((v as unknown as { text: unknown }).text ?? ''));
      } else if (typeof v === 'object' && 'result' in (v as unknown as Record<string, unknown>)) {
        values.push(String((v as unknown as { result: unknown }).result ?? ''));
      } else {
        values.push(String(v));
      }
    }
    rows.push(values);
  });
  return rows;
}

const TRUE_LITERALS = new Set(['true', '1', 'oui', 'yes', 'vrai', 'x']);
const FALSE_LITERALS = new Set(['false', '0', 'non', 'no', 'faux', '']);

function coerceCell(raw: string, col: ClaimColumnDef): { value: unknown; error?: string } {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return { value: undefined };

  switch (col.type) {
    case 'string':
      return { value: trimmed };

    case 'number': {
      const n = Number(trimmed.replace(/\s/g, '').replace(',', '.'));
      if (Number.isNaN(n)) return { value: undefined, error: `${col.label} : valeur numérique attendue (reçu "${raw}")` };
      return { value: n };
    }

    case 'boolean': {
      const lower = trimmed.toLowerCase();
      if (TRUE_LITERALS.has(lower)) return { value: true };
      if (FALSE_LITERALS.has(lower)) return { value: false };
      return { value: undefined, error: `${col.label} : booléen attendu (reçu "${raw}")` };
    }

    case 'date': {
      const d = new Date(trimmed.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed);
      if (Number.isNaN(d.getTime())) return { value: undefined, error: `${col.label} : date invalide (reçu "${raw}")` };
      return { value: d.toISOString().slice(0, 10) };
    }

    case 'enum': {
      const upper = trimmed.toUpperCase();
      const match = col.enumValues?.find((v) => v.toUpperCase() === upper);
      if (!match) {
        return {
          value: undefined,
          error: `${col.label} : valeur "${raw}" non reconnue (attendu : ${col.enumValues?.join(' | ')})`,
        };
      }
      return { value: match };
    }

    case 'string[]': {
      const items = trimmed
        .split(/[;,|]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return { value: items };
    }

    default:
      return { value: trimmed };
  }
}

/** Mappe une ligne brute (cellules dans l'ordre du modèle) vers le modèle 47 colonnes typé. */
export function mapRow(cells: string[]): { values: Record<string, unknown>; errors: string[] } {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const col of CLAIM_IMPORT_COLUMNS) {
    const raw = cells[col.index - 1] ?? '';
    const { value, error } = coerceCell(String(raw ?? ''), col);
    values[col.key] = value;
    if (error) errors.push(error);
  }
  return { values, errors };
}

/**
 * Parse un fichier d'import (buffer) et renvoie les lignes typées
 * (en-tête ignoré). Format déduit de l'extension du nom de fichier.
 */
export async function parseClaimFile(buffer: Buffer, fileName: string): Promise<ParsedClaimRow[]> {
  const format = detectFormat(fileName);
  const rawRows = format === 'xlsx' ? await parseXlsxBuffer(buffer) : parseCsvBuffer(buffer);
  const dataRows = rawRows.slice(1); // ligne 1 = en-tête (modèle téléchargeable, B.4)

  return dataRows.map((cells, i) => {
    const { values, errors } = mapRow(cells);
    return { rowNumber: i + 1, values, errors };
  });
}
