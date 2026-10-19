/**
 * Règles métier du CommissionModule — B.2, écran 7 "Commission". Fonctions
 * PURES, testées sans Nest ni base de données (même esprit que
 * `recours.rules.ts`/`settlement.rules.ts`).
 */

export const COMMISSION_CASE_STATUSES = ['A_INSTRUIRE', 'EN_DELIBERE', 'PRONONCE'] as const;
export type CommissionCaseStatus = (typeof COMMISSION_CASE_STATUSES)[number];

const STATUS_ORDER: CommissionCaseStatus[] = ['A_INSTRUIRE', 'EN_DELIBERE', 'PRONONCE'];

/**
 * Un dossier de conciliation avance STRICTEMENT dans l'ordre
 * A_INSTRUIRE -> EN_DELIBERE -> PRONONCE, jamais en arrière, jamais en
 * sautant une étape (ex: on ne peut pas prononcer une décision sans être
 * passé par la délibération).
 */
export function canAdvanceCaseStatus(from: CommissionCaseStatus, to: CommissionCaseStatus): boolean {
  const fromIdx = STATUS_ORDER.indexOf(from);
  const toIdx = STATUS_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return false;
  return toIdx === fromIdx + 1;
}

export const SANCTION_TYPES = ['PENALITE_FINANCIERE', 'AVERTISSEMENT', 'SUSPENSION'] as const;
export type SanctionType = (typeof SANCTION_TYPES)[number];

/** SEC-32 : une sanction proposée n'est prononcée qu'après le contreseing d'un second membre. */
export const SANCTION_STATUSES = ['A_CONTRESIGNER', 'PRONONCEE'] as const;
export type SanctionStatus = (typeof SANCTION_STATUSES)[number];

/** Une pénalité/sanction ne peut viser qu'une des deux compagnies parties au recours à l'origine du dossier. */
export function isCompanyPartyToCase(companyCode: string, companyA: string, companyB: string): boolean {
  return companyCode === companyA || companyCode === companyB;
}
