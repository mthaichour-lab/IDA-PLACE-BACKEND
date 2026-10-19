import { FraudCaseViewDto } from './dto/fraud.dto';

/**
 * SEC-26 — minimisation des cas de fraude pour un rôle compagnie : un cas
 * reste visible à chaque compagnie partie (détection inter-compagnies par
 * nature), mais elle ne reçoit que SES dossiers et le NOMBRE de dossiers et
 * de compagnies en contrepartie — jamais les id de dossiers, montants,
 * plaques ou codes des concurrentes. Les rôles place voient tout.
 */

/** Indicateurs agrégés sans donnée d'une autre compagnie. */
const AGGREGATE_DETAIL_KEYS = ['count', 'companiesCount', 'windowDays', 'datesDistinctes', 'wilayasDistinctes', 'diffRatio', 'wilayaMismatch', 'dateMismatch', 'day', 'bandMin', 'bandMax'];
/** Détails qui décrivent un dossier de la compagnie elle-même (plaque, e-constat, date) : publiés seulement si elle a un dossier dans le cas. */
const OWN_DETAIL_KEYS = ['plateA', 'numEconstat', 'accidentDate'];

export interface ClaimOwnership {
  company: string;
  plateA?: string;
}

export function projectFraudCase(c: FraudCaseViewDto, tenant: string | undefined, claims: Map<string, ClaimOwnership>): FraudCaseViewDto {
  const firstPlate = (ids: string[]) => ids.map((id) => claims.get(id)?.plateA).find((p) => p);
  if (!tenant) return { ...c, plateA: firstPlate(c.claimIds) };

  const own = c.claimIds.filter((id) => claims.get(id)?.company === tenant);
  const details: Record<string, unknown> = {};
  for (const key of AGGREGATE_DETAIL_KEYS) if (key in c.details) details[key] = c.details[key];
  if (own.length > 0) for (const key of OWN_DETAIL_KEYS) if (key in c.details) details[key] = c.details[key];
  if (c.details.company === tenant) details.company = tenant;
  // Incohérence A/B : seul le montant du côté de la compagnie est publié.
  if (c.type === 'INCOHERENCE_AB') {
    if (own.includes(c.claimIds[0]) && 'amountA' in c.details) details.amountA = c.details.amountA;
    if (own.includes(c.claimIds[1]) && 'amountB' in c.details) details.amountB = c.details.amountB;
  }

  return {
    ...c,
    claimIds: own,
    companiesInvolved: [tenant],
    details,
    plateA: firstPlate(own),
    counterpartClaims: c.claimIds.length - own.length,
    counterpartCompanies: c.companiesInvolved.filter((x) => x !== tenant).length,
  };
}
