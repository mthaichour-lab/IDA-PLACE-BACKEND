import { BadRequestException, ConflictException } from '@nestjs/common';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function assertIsoDate(value: string, field: string): void {
  if (!isValidIsoDate(value)) {
    throw new BadRequestException({ code: 'BAD_REQUEST', message: `${field} : date ISO invalide (AAAA-MM-JJ attendu), reçu "${value}".` });
  }
}

/**
 * Règle des quatre yeux (décision PO, règles transverses) : le validateur n'est
 * l'auteur d'aucune saisie de la valeur. SEC-30 : `authors` doit contenir
 * l'historique COMPLET des auteurs (voir `withAuthor`), pas seulement le
 * dernier — sinon un auteur faisait modifier un champ par un tiers (qui
 * écrasait `updatedBy`) puis validait lui-même.
 */
export function assertFourEyes(user: AuthenticatedUser, authors: Array<string | undefined>): void {
  if (authors.includes(user.id)) {
    throw new ConflictException({
      code: 'FOUR_EYES',
      message: 'Règle des quatre yeux : la validation doit être faite par une autre personne que l’auteur de la saisie.',
    });
  }
}

export interface WilayaPerimeter {
  code: string;
  effectiveFrom?: string;
  parentCode?: string;
}

/**
 * Une population antérieure au périmètre actuel est invalide, pour la wilaya
 * fille comme pour la wilaya mère (décision PO §3). Comparaison au 1er janvier
 * de l'année de référence : un chiffre de l'année du découpage couvre encore
 * en partie l'ancien périmètre.
 */
export function populationInvalidReason(wilayaCode: string, referenceYear: number, wilayas: WilayaPerimeter[]): string | undefined {
  const yearStart = `${String(referenceYear).padStart(4, '0')}-01-01`;
  const self = wilayas.find((w) => w.code === wilayaCode);
  if (self?.effectiveFrom && yearStart < self.effectiveFrom) {
    return `Année ${referenceYear} antérieure au périmètre actuel de la wilaya ${wilayaCode} (en vigueur depuis le ${self.effectiveFrom}).`;
  }
  for (const child of wilayas) {
    if (child.parentCode === wilayaCode && child.effectiveFrom && yearStart < child.effectiveFrom) {
      return `Année ${referenceYear} antérieure au détachement de la wilaya ${child.code} (le ${child.effectiveFrom}) : périmètre de la wilaya ${wilayaCode} modifié depuis.`;
    }
  }
  return undefined;
}

/** SEC-30 : ajoute un auteur à l'historique (sans doublon, jamais d'effacement). */
export function withAuthor(authors: readonly string[] | undefined | null, userId: string): string[] {
  return [...new Set([...(authors ?? []), userId])];
}

/** SEC-30 : la validation porte sur la révision lue par le valideur (409 si la valeur a changé depuis). */
export function assertExpectedRevision(current: number | undefined, expected: number | undefined): void {
  if (expected !== undefined && expected !== (current ?? 1)) {
    throw new ConflictException({
      code: 'REVISION_PERIMEE',
      message: `La valeur a été modifiée depuis votre lecture (révision ${current ?? 1}, vous validiez la révision ${expected}) : relisez-la avant de valider.`,
    });
  }
}
