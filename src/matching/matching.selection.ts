import { computeMatchScore, MATCH_WEIGHTS, MatchScoreResult, normalizeMatchValue } from './matching.scoring';
import { ClaimMatchInput } from './matching.types';

/**
 * Sélection de la contrepartie d'une déclaration — SEC-03 (minimisation) et
 * SEC-12 (coût de l'appariement). Fonctions PURES, testées sans Nest.
 *
 *  - Pool limité à la compagnie adverse DÉCLARÉE par la déclaration
 *    (`counterpartyCompany`) quand elle est renseignée : une déclaration
 *    d'une compagnie non désignée n'est jamais candidate.
 *  - Seuil minimal : un candidat n'est retenu qu'à partir du niveau MANUEL
 *    (`confirmThreshold`, déjà paramétrable par MATCHING_CONFIRM_THRESHOLD,
 *    voir `levelForScore`) ; en deçà, la déclaration reste « non appariée »
 *    au lieu de copier les champs d'une déclaration tierce au moindre point
 *    commun.
 *  - Départage déterministe des égalités : date de réception la plus
 *    ancienne, puis id (ordre lexicographique) — signalé à l'appelant pour
 *    journalisation.
 *  - Index en mémoire par clé de rapprochement (e-constat, plaques, polices)
 *    au lieu d'un balayage de toute la base pour chaque déclaration.
 */

/**
 * Score maximal atteignable SANS aucune clé indexée commune (date/heure +
 * compagnies croisées + GPS = 35). Tant que le seuil de rétention est
 * strictement supérieur, un candidat retenu partage forcément au moins une
 * clé (e-constat, plaque ou police) : l'index est exact.
 */
export const NON_INDEXED_MAX_SCORE = MATCH_WEIGHTS.dateHeure + MATCH_WEIGHTS.compagniesCroisees + MATCH_WEIGHTS.gps;

type KeySource = Pick<ClaimMatchInput, 'numEconstat' | 'plateA' | 'plateB' | 'policeA' | 'policeB'>;

/** Clés de rapprochement d'une déclaration : `E:` e-constat, `P:` plaque normalisée, `N:` police/attestation normalisée. */
export function matchKeysFor(c: KeySource): string[] {
  const keys = new Set<string>();
  const econstat = c.numEconstat?.trim();
  if (econstat) keys.add(`E:${econstat}`);
  for (const plate of [c.plateA, c.plateB]) {
    const n = normalizeMatchValue(plate);
    if (n) keys.add(`P:${n}`);
  }
  for (const police of [c.policeA, c.policeB]) {
    const n = normalizeMatchValue(police);
    if (n) keys.add(`N:${n}`);
  }
  return [...keys];
}

/** Une déclaration peut-elle être la contrepartie de `claim` ? (jamais elle-même, et seulement la compagnie adverse déclarée si elle l'est). */
export function isDesignatedCounterpart(claim: ClaimMatchInput, candidate: ClaimMatchInput): boolean {
  if (candidate.id === claim.id) return false;
  if (claim.counterpartyCompany && candidate.company !== claim.counterpartyCompany) return false;
  return true;
}

/** Ordre de départage à score égal : réception la plus ancienne d'abord (sans date : après), puis id. */
export function compareForTieBreak(a: ClaimMatchInput, b: ClaimMatchInput): number {
  const ra = a.receivedAt ?? '￿';
  const rb = b.receivedAt ?? '￿';
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface CandidateSelection {
  candidate: ClaimMatchInput;
  result: MatchScoreResult;
  /** Vrai si plusieurs candidats avaient le meilleur score (départage appliqué). */
  tieBroken: boolean;
}

export function selectBestCandidate(claim: ClaimMatchInput, pool: Iterable<ClaimMatchInput>, minScore: number): CandidateSelection | undefined {
  let best: CandidateSelection | undefined;
  for (const candidate of pool) {
    if (!isDesignatedCounterpart(claim, candidate)) continue;
    const result = computeMatchScore(claim, candidate);
    if (result.score <= 0 || result.score < minScore) continue;
    if (!best || result.score > best.result.score) {
      best = { candidate, result, tieBroken: false };
    } else if (result.score === best.result.score) {
      const winner = compareForTieBreak(candidate, best.candidate) < 0 ? candidate : best.candidate;
      best = { candidate: winner, result: winner === candidate ? result : best.result, tieBroken: true };
    }
  }
  return best;
}

/** Index des déclarations par clé de rapprochement (SEC-12 : plus de balayage O(n) par déclaration). */
export class MatchCandidateIndex {
  private readonly byId = new Map<string, ClaimMatchInput>();
  private readonly byKey = new Map<string, Set<string>>();

  constructor(pool: Iterable<ClaimMatchInput> = []) {
    for (const c of pool) this.add(c);
  }

  add(c: ClaimMatchInput): void {
    this.byId.set(c.id, c);
    for (const key of matchKeysFor(c)) {
      let ids = this.byKey.get(key);
      if (!ids) this.byKey.set(key, (ids = new Set()));
      ids.add(c.id);
    }
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Déclarations partageant au moins une clé avec `claim` (elle-même exclue). */
  candidatesFor(claim: ClaimMatchInput): ClaimMatchInput[] {
    const ids = new Set<string>();
    for (const key of matchKeysFor(claim)) for (const id of this.byKey.get(key) ?? []) ids.add(id);
    ids.delete(claim.id);
    return [...ids].map((id) => this.byId.get(id)!);
  }

  all(): ClaimMatchInput[] {
    return [...this.byId.values()];
  }
}
