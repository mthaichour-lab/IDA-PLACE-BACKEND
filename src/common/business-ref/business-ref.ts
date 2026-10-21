import { EntityManager } from '@mikro-orm/postgresql';

/**
 * Références métier lisibles, séquentielles et immuables (écrans 2, 4, 5, 7,
 * 8 et cockpit) — l'identifiant technique reste l'UUID, la référence est ce
 * que les agents se communiquent :
 *
 *  - recours (Annexe 2) : `REC-AAAA-NNNNN`, numérotation annuelle ;
 *  - dossier de commission : `CSC-AAAA-NNN`, numérotation annuelle ;
 *  - ligne de confrontation : `MAT-AAMMJJ-NNN`, numérotation quotidienne.
 *
 * La période se lit à l'heure d'Alger (UTC+1, sans heure d'été) : un recours
 * ouvert le 31 décembre à 23 h 30 appartient à l'année qui se termine.
 *
 * Source de vérité : la fonction SQL `next_business_ref(kind, at)`
 * (Migration20261021000000_ReferencesMetier) — compteur par (type, période)
 * incrémenté par un `INSERT … ON CONFLICT DO UPDATE … RETURNING`, atomique :
 * deux créations concurrentes ne reçoivent jamais le même numéro, et le
 * verrou de ligne posé jusqu'à la fin de la transaction rend la numérotation
 * sans trou lorsque l'appel a lieu dans la transaction de création. Un
 * déclencheur attribue la référence à toute insertion qui n'en porte pas et
 * en refuse toute modification ultérieure. Les fonctions TypeScript
 * ci-dessous reproduisent le même format, pour le repli mémoire (mode
 * dégradé, hors production) et les tests.
 */
export type BusinessRefKind = 'REC' | 'CSC' | 'MAT';

const WIDTH: Record<BusinessRefKind, number> = { REC: 5, CSC: 3, MAT: 3 };

/** Format reconnu d'une référence métier (tout type). */
export const BUSINESS_REF_PATTERN = /^(REC-\d{4}-\d{5,}|CSC-\d{4}-\d{3,}|MAT-\d{6}-\d{3,})$/;

const ALGIERS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Période de numérotation à l'heure d'Alger : `AAAA` (REC, CSC) ou `AAMMJJ` (MAT). */
export function businessRefPeriod(kind: BusinessRefKind, at: Date): string {
  const parts = Object.fromEntries(ALGIERS.formatToParts(at).map((p) => [p.type, p.value]));
  return kind === 'MAT' ? `${parts.year.slice(2)}${parts.month}${parts.day}` : parts.year;
}

/** Même rendu que la fonction SQL : zéros à gauche, jamais de troncature au-delà de la largeur. */
export function formatBusinessRef(kind: BusinessRefKind, period: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Numéro de référence invalide : ${n}`);
  return `${kind}-${period}-${String(n).padStart(WIDTH[kind], '0')}`;
}

/** Prochaine référence, attribuée par la base (dans la transaction de `em` si elle en a une). */
export async function nextBusinessRef(em: EntityManager, kind: BusinessRefKind, at: Date): Promise<string> {
  const rows = await em.execute<Array<{ ref: string }>>('select next_business_ref(?, ?) as ref', [kind, at.toISOString()]);
  const ref = rows[0]?.ref;
  if (!ref) throw new Error(`Référence ${kind} non attribuée par la base`);
  return ref;
}

/** Compteur du repli mémoire (mode dégradé) : même format, numérotation propre au process. */
export class MemoryBusinessRefCounter {
  private readonly last = new Map<string, number>();

  next(kind: BusinessRefKind, at: Date): string {
    const period = businessRefPeriod(kind, at);
    const key = `${kind}|${period}`;
    const n = (this.last.get(key) ?? 0) + 1;
    this.last.set(key, n);
    return formatBusinessRef(kind, period, n);
  }
}
