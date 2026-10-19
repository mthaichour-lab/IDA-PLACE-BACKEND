import { normalizeReferenceCode, PublishedBaremeCase, PublishedVehicleCategory, resolvePublishedBaremeCase } from '../adherents/bareme-rules';
import { CLAIM_IMPORT_EXTENSION_COLUMNS } from './claim-extension-columns';
import { ClaimExtensionValues, ClaimImportWarning } from './claim-parser';

/** Champs Art. 14 d'un dossier (décision PO §5) — `null` efface la valeur. */
export interface ClaimArt14Fields {
  circonstancesA?: number[] | null;
  circonstancesB?: number[] | null;
  baremeVersionId?: string | null;
  baremeCode?: string | null;
  vehicleCategoryA?: string | null;
  vehicleCategoryB?: string | null;
  responsabiliteDeclareeA?: number | null;
  responsabiliteDeclareeB?: number | null;
}

const column = (key: string) => CLAIM_IMPORT_EXTENSION_COLUMNS.find((c) => c.key === key)!;

function unpublished(key: string, message: string): ClaimImportWarning {
  const col = column(key);
  return { column: col.index, columnKey: col.key, code: 'BAREME_NON_PUBLIE', message: `Barème non publié : ${message} — valeur ignorée.` };
}

/**
 * Champs Art. 14 d'une ligne importée. La responsabilité déclarée est une
 * copie des colonnes 32-33 ; un code ou une catégorie absent du référentiel
 * `VALIDE_UAR` est ignoré avec un avertissement, sans rendre la ligne inéligible.
 */
export function resolveImportedArt14(
  values: Record<string, unknown>,
  extension: ClaimExtensionValues,
  cases: PublishedBaremeCase[],
  categories: PublishedVehicleCategory[],
): { fields: ClaimArt14Fields; warnings: ClaimImportWarning[] } {
  const warnings: ClaimImportWarning[] = [];
  const fields: ClaimArt14Fields = {
    circonstancesA: extension.circonstancesA,
    circonstancesB: extension.circonstancesB,
    responsabiliteDeclareeA: values.responsabiliteDeclareeA as number | undefined,
    responsabiliteDeclareeB: values.responsabiliteDeclareeB as number | undefined,
  };

  if (extension.baremeCode) {
    const found = resolvePublishedBaremeCase(cases, extension.baremeCode, extension.baremeVersion);
    if (found) {
      fields.baremeCode = found.code;
      fields.baremeVersionId = found.versionId;
    } else {
      const scope = extension.baremeVersion ? ` dans la version « ${extension.baremeVersion} »` : '';
      warnings.push(unpublished('baremeCode', `code « ${extension.baremeCode} » absent de toute version VALIDE_UAR${scope}`));
    }
  }

  const published = new Set(categories.map((c) => c.code));
  for (const key of ['vehicleCategoryA', 'vehicleCategoryB'] as const) {
    const raw = extension[key];
    if (!raw) continue;
    const code = normalizeReferenceCode(raw);
    if (published.has(code)) fields[key] = code;
    else warnings.push(unpublished(key, `catégorie « ${raw} » non validée UAR`));
  }

  return { fields, warnings };
}
