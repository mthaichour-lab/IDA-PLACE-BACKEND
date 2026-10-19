import { PublishedBaremeCase, resolvePublishedBaremeCase } from '../adherents/bareme-rules';
import { DeclarationResponsabilite } from './matching.types';

export interface TauxSelonBareme {
  baremeVersionId: string;
  versionLabel: string;
  partA: number;
  partB: number;
}

export type DeclarationResponsabiliteView = DeclarationResponsabilite & { tauxSelonBareme?: TauxSelonBareme };

/** Bloc vide = `undefined` : un dossier antérieur au modèle étendu n'a rien à confronter. */
export function compactResponsabilite(r?: DeclarationResponsabilite): DeclarationResponsabilite | undefined {
  if (!r) return undefined;
  const entries = Object.entries(r).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0));
  return entries.length > 0 ? (Object.fromEntries(entries) as DeclarationResponsabilite) : undefined;
}

/** Divergence : les deux déclarations portent un code de barème, et ces codes diffèrent. */
export function computeDivergence(a?: DeclarationResponsabilite, b?: DeclarationResponsabilite): boolean {
  return !!a?.baremeCode && !!b?.baremeCode && a.baremeCode !== b.baremeCode;
}

/** Ajoute les parts du barème seulement si une version `VALIDE_UAR` couvre le code ; aucune déduction depuis les circonstances. */
export function withTauxSelonBareme(r: DeclarationResponsabilite | undefined, cases: PublishedBaremeCase[]): DeclarationResponsabiliteView | undefined {
  if (!r?.baremeCode) return r;
  const found = resolvePublishedBaremeCase(cases, r.baremeCode, r.baremeVersionId);
  if (!found) return r;
  return { ...r, tauxSelonBareme: { baremeVersionId: found.versionId, versionLabel: found.versionLabel, partA: found.partA, partB: found.partB } };
}
