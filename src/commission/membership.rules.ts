/**
 * Adhésions et retraits — Chapitre VI de la convention IDA (Art. 30-35).
 * Fonctions PURES, testées sans Nest ni base de données.
 */

export const MEMBERSHIP_TYPES = ['ADHESION', 'RETRAIT'] as const;
export type MembershipType = (typeof MEMBERSHIP_TYPES)[number];

export const MEMBERSHIP_STATES = ['RECUE', 'ACCEPTEE', 'REJETEE', 'EFFECTIVE', 'ANNULEE'] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];

export const MEMBERSHIP_ACTIONS = ['accept', 'reject', 'effective', 'cancel'] as const;
export type MembershipAction = (typeof MEMBERSHIP_ACTIONS)[number];

// Le retrait est un droit unilatéral de l'adhérent (Art. 30-35) : il n'y a
// pas de rejet possible, seulement une annulation à sa demande.
const TRANSITIONS: Record<MembershipType, Partial<Record<MembershipAction, MembershipState>>> = {
  ADHESION: { accept: 'ACCEPTEE', reject: 'REJETEE' },
  RETRAIT: { effective: 'EFFECTIVE', cancel: 'ANNULEE' },
};

/** État cible de `action` sur une demande `type` à l'état `state`, ou `undefined` si la transition est interdite. */
export function nextMembershipState(type: MembershipType, state: MembershipState, action: MembershipAction): MembershipState | undefined {
  if (state !== 'RECUE') return undefined;
  return TRANSITIONS[type][action];
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `true` si `value` est une date calendaire valide au format AAAA-MM-JJ. */
export function isIsoCalendarDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/**
 * Date d'effet d'un retrait : « dénonciation par préavis d'au moins 3 mois
 * avant la fin de l'année civile ». Décision PO : un courrier reçu au plus
 * tard le 30 septembre prend effet le 31 décembre de la même année ; reçu à
 * partir du 1er octobre, il ne prend effet que le 31 décembre suivant.
 */
export function computeWithdrawalEffectiveDate(receivedAt: string): string {
  if (!isIsoCalendarDate(receivedAt)) throw new Error(`Date de réception invalide : "${receivedAt}" (attendu AAAA-MM-JJ)`);
  const year = Number(receivedAt.slice(0, 4));
  return receivedAt <= `${year}-09-30` ? `${year}-12-31` : `${year + 1}-12-31`;
}

/** Le retrait ne peut être constaté qu'une fois la date d'effet passée (strictement). */
export function isWithdrawalEffectiveReached(effectiveDate: string, now: Date): boolean {
  return now.toISOString().slice(0, 10) > effectiveDate;
}
