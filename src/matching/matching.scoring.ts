import { ClaimMatchInput } from './matching.types';

/**
 * Clé d'appariement + score pondéré — B.5. Fonctions PURES (aucune I/O,
 * aucune dépendance Nest/ORM) afin d'être unitairement testables :
 *  - clé **exacte** : n° e-constat partagé entre les deux déclarations ;
 *  - clé **composite** (à défaut) : paire de plaques NON ORDONNÉE
 *    {immatA, immatB} + date/heure (± 2 j / ± 60 min) + wilaya/commune +
 *    n° police/attestation croisés ;
 *  - score 0-100 : plaques croisées 35, police croisée 15, date-heure 15,
 *    compagnies croisées 10, GPS 10 (e-constat partagé ⇒ 100, clé exacte).
 */

export interface MatchTolerances {
  dateToleranceDays: number;
  timeToleranceMinutes: number;
  gpsToleranceKm: number;
}

export const DEFAULT_MATCH_TOLERANCES: MatchTolerances = {
  dateToleranceDays: 2,
  timeToleranceMinutes: 60,
  gpsToleranceKm: 2,
};

export interface MatchCriteriaResult {
  econstatPartage: boolean;
  plaquesCroisees: boolean;
  policeCroisee: boolean;
  dateHeure: boolean;
  compagniesCroisees: boolean;
  gps: boolean;
}

export interface MatchScoreResult {
  score: number;
  criteria: MatchCriteriaResult;
  econstatShared: boolean;
  /** 'EXACTE' = n° e-constat partagé ; 'COMPOSITE' = au moins un critère composite vérifié ; 'AUCUNE' = aucune correspondance. */
  key: 'EXACTE' | 'COMPOSITE' | 'AUCUNE';
}

export const MATCH_WEIGHTS = {
  plaquesCroisees: 35,
  policeCroisee: 15,
  dateHeure: 15,
  compagniesCroisees: 10,
  gps: 10,
} as const;

function normalize(value: string | undefined | null): string | undefined {
  const v = value?.trim().toUpperCase().replace(/[\s-]+/g, '');
  return v ? v : undefined;
}

/** Compare deux paires {a1,a2} / {b1,b2} comme des ENSEMBLES non ordonnés. */
function sameUnorderedPair(a1?: string, a2?: string, b1?: string, b2?: string): boolean {
  const na1 = normalize(a1);
  const na2 = normalize(a2);
  const nb1 = normalize(b1);
  const nb2 = normalize(b2);
  if (!na1 || !na2 || !nb1 || !nb2) return false;
  return (na1 === nb1 && na2 === nb2) || (na1 === nb2 && na2 === nb1);
}

function hasExactEconstat(a: ClaimMatchInput, b: ClaimMatchInput): boolean {
  const ea = a.numEconstat?.trim();
  const eb = b.numEconstat?.trim();
  return Boolean(ea && eb && ea === eb);
}

function hasPlaquesCroisees(a: ClaimMatchInput, b: ClaimMatchInput): boolean {
  return sameUnorderedPair(a.plateA, a.plateB, b.plateA, b.plateB);
}

function hasPoliceCroisee(a: ClaimMatchInput, b: ClaimMatchInput): boolean {
  const setA = [normalize(a.policeA), normalize(a.policeB)].filter((v): v is string => Boolean(v));
  const setB = [normalize(b.policeA), normalize(b.policeB)].filter((v): v is string => Boolean(v));
  if (setA.length === 0 || setB.length === 0) return false;
  return setA.some((v) => setB.includes(v));
}

/** Combine date (YYYY-MM-DD) + heure optionnelle (HH:mm) en timestamp ms (UTC). */
function toTimestamp(date?: string, time?: string): number | undefined {
  if (!date) return undefined;
  const iso = time ? `${date}T${time}:00Z` : `${date}T00:00:00Z`;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? undefined : t;
}

function hasDateHeureMatch(a: ClaimMatchInput, b: ClaimMatchInput, tol: MatchTolerances): boolean {
  const ta = toTimestamp(a.accidentDate, a.accidentTime);
  const tb = toTimestamp(b.accidentDate, b.accidentTime);
  if (ta === undefined || tb === undefined) return false;
  const diffMs = Math.abs(ta - tb);
  if (a.accidentTime && b.accidentTime) {
    return diffMs <= tol.timeToleranceMinutes * 60_000;
  }
  return diffMs <= tol.dateToleranceDays * 86_400_000;
}

function hasCompagniesCroisees(a: ClaimMatchInput, b: ClaimMatchInput): boolean {
  if (!a.company || !b.company) return false;
  return Boolean(
    a.counterpartyCompany &&
      b.counterpartyCompany &&
      a.company === b.counterpartyCompany &&
      b.company === a.counterpartyCompany,
  );
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function hasGpsMatch(a: ClaimMatchInput, b: ClaimMatchInput, tol: MatchTolerances): boolean {
  if (a.gpsLat === undefined || a.gpsLng === undefined || b.gpsLat === undefined || b.gpsLng === undefined) {
    return false;
  }
  return haversineKm(a.gpsLat, a.gpsLng, b.gpsLat, b.gpsLng) <= tol.gpsToleranceKm;
}

/**
 * Calcule le score d'appariement pondéré entre deux déclarations — B.5.
 * Un n° e-constat partagé (clé exacte) donne directement 100 et court-circuite
 * le calcul composite.
 */
export function computeMatchScore(
  a: ClaimMatchInput,
  b: ClaimMatchInput,
  tolerances: MatchTolerances = DEFAULT_MATCH_TOLERANCES,
): MatchScoreResult {
  const econstatShared = hasExactEconstat(a, b);

  if (econstatShared) {
    return {
      score: 100,
      econstatShared: true,
      key: 'EXACTE',
      criteria: {
        econstatPartage: true,
        plaquesCroisees: hasPlaquesCroisees(a, b),
        policeCroisee: hasPoliceCroisee(a, b),
        dateHeure: hasDateHeureMatch(a, b, tolerances),
        compagniesCroisees: hasCompagniesCroisees(a, b),
        gps: hasGpsMatch(a, b, tolerances),
      },
    };
  }

  const criteria: MatchCriteriaResult = {
    econstatPartage: false,
    plaquesCroisees: hasPlaquesCroisees(a, b),
    policeCroisee: hasPoliceCroisee(a, b),
    dateHeure: hasDateHeureMatch(a, b, tolerances),
    compagniesCroisees: hasCompagniesCroisees(a, b),
    gps: hasGpsMatch(a, b, tolerances),
  };

  const score =
    (criteria.plaquesCroisees ? MATCH_WEIGHTS.plaquesCroisees : 0) +
    (criteria.policeCroisee ? MATCH_WEIGHTS.policeCroisee : 0) +
    (criteria.dateHeure ? MATCH_WEIGHTS.dateHeure : 0) +
    (criteria.compagniesCroisees ? MATCH_WEIGHTS.compagniesCroisees : 0) +
    (criteria.gps ? MATCH_WEIGHTS.gps : 0);

  return { score, econstatShared: false, key: score > 0 ? 'COMPOSITE' : 'AUCUNE', criteria };
}

export interface MatchLevelThresholds {
  autoThreshold: number;
  confirmThreshold: number;
}

/** Détermine le niveau (AUTO/MANUEL/NON) à partir du score et des seuils paramétrables. */
export function levelForScore(score: number, thresholds: MatchLevelThresholds): 'AUTO' | 'MANUEL' | 'NON' {
  if (score >= thresholds.autoThreshold) return 'AUTO';
  if (score >= thresholds.confirmThreshold) return 'MANUEL';
  return 'NON';
}
