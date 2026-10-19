import { BadRequestException } from '@nestjs/common';
import { CONSTAT_CIRCUMSTANCE_MAX, CONSTAT_CIRCUMSTANCE_MIN } from './place-referential.data';

/** Cas d'une version `VALIDE_UAR` — seule forme du barème visible hors du référentiel. */
export interface PublishedBaremeCase {
  versionId: string;
  versionLabel: string;
  validatedAt: string;
  code: string;
  label: string;
  partA: number;
  partB: number;
}

export interface PublishedVehicleCategory {
  code: string;
  label: string;
}

export function assertBaremeParts(partA: number, partB: number): void {
  if (partA + partB !== 100) {
    throw new BadRequestException({ code: 'PARTS_INVALIDES', message: `partA + partB doit valoir 100 (reçu ${partA} + ${partB} = ${partA + partB}).` });
  }
}

export function normalizeReferenceCode(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Cas publié couvrant `code`. `versionRef` (id ou libellé) restreint la
 * recherche à une version ; sinon la version validée le plus récemment l'emporte.
 */
export function resolvePublishedBaremeCase(cases: PublishedBaremeCase[], code: string, versionRef?: string): PublishedBaremeCase | undefined {
  const wanted = normalizeReferenceCode(code);
  const ref = versionRef?.trim();
  return cases
    .filter((c) => c.code === wanted && (!ref || c.versionId === ref || c.versionLabel === ref))
    .sort((a, b) => b.validatedAt.localeCompare(a.validatedAt))[0];
}

export function isValidCircumstance(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= CONSTAT_CIRCUMSTANCE_MIN && (n as number) <= CONSTAT_CIRCUMSTANCE_MAX;
}

/** Cases cochées du constat : entiers 1-17, sans doublon, triés. */
export function normalizeCircumstances(values: number[]): number[] {
  const invalid = values.filter((v) => !isValidCircumstance(v));
  if (invalid.length > 0) {
    throw new BadRequestException({ code: 'CIRCONSTANCE_INVALIDE', message: `Circonstances du constat : entiers de 1 à 17 attendus (reçu ${invalid.join(', ')}).` });
  }
  return [...new Set(values)].sort((a, b) => a - b);
}
