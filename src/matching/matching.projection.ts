import { MatchQueueItemDto } from './dto/matching.dto';

/**
 * SEC-03 — minimisation (loi 18-07) : une compagnie ne reçoit les champs
 * nominatifs de la déclaration d'une autre compagnie qu'une fois
 * l'appariement confirmé (`AUTO_CONFIRME` — clé exacte ou score ≥ seuil
 * AUTO — ou `CONFIRME_MANUEL`). Avant, seuls les éléments de rapprochement
 * restent visibles (score, critères, niveau, date, wilaya, référence) ; les
 * champs nominatifs de l'autre côté sont remplacés par `MASKED` (ou omis
 * pour les blocs structurés). Les rôles place voient tout.
 */
export const MASKED = '••••';

const DISCLOSED_STATUSES = new Set(['AUTO_CONFIRME', 'CONFIRME_MANUEL']);

export function isDisclosed(status: string): boolean {
  return DISCLOSED_STATUSES.has(status);
}

const mask = (v: string | undefined): string | undefined => (v === undefined || v === null ? v : MASKED);

function maskSideA<T extends MatchQueueItemDto>(row: T): T {
  return { ...row, plateA: MASKED, policeA: mask(row.policeA), assureAIdentite: mask(row.assureAIdentite), canalDeclarationA: mask(row.canalDeclarationA), responsabiliteA: undefined, masked: true };
}

function maskSideB<T extends MatchQueueItemDto>(row: T): T {
  if (!row.companyB) return row;
  return { ...row, plateB: mask(row.plateB), policeB: mask(row.policeB), assureBIdentite: mask(row.assureBIdentite), canalDeclarationB: mask(row.canalDeclarationB), responsabiliteB: undefined, masked: true };
}

/**
 * Projette une ligne de la file pour un lecteur : `tenant` = compagnie du
 * lecteur (`undefined` pour un rôle place). Le côté du lecteur reste
 * intact ; l'autre côté est masqué tant que l'appariement n'est pas confirmé.
 */
export function projectForViewer<T extends MatchQueueItemDto>(row: T, tenant: string | undefined): T {
  if (!tenant || isDisclosed(row.status)) return row;
  const viewerIsA = row.companyA === tenant;
  const viewerIsB = row.companyB === tenant;
  if (viewerIsA && viewerIsB) return row;
  if (viewerIsA) return maskSideB(row);
  if (viewerIsB) return maskSideA(row);
  // Hors périmètre : jamais servi (contrôle de visibilité en amont) — par prudence, tout masquer.
  return maskSideB(maskSideA(row));
}
