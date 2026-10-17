/**
 * FraudModule — écran 9 "Anti-fraude", B.2/B.9. Fonctions PURES (aucune I/O,
 * aucune dépendance Nest) pour les 5 détections demandées pour ce sprint,
 * à partir des seules données RÉELLEMENT disponibles dans ce worktree
 * (`ClaimsModule`/`MatchingModule`) :
 *   1. Doublons (même véhicule/plaque, même jour, déclarations distinctes
 *      de la MÊME compagnie — une "vraie" collision entre deux compagnies
 *      différentes sur le même véhicule/jour est l'appariement normal de
 *      MatchingModule, pas une fraude).
 *   2. E-constat réutilisé sur déclarations divergentes (même n° e-constat
 *      porté par plus de 2 déclarations, OU par exactement 2 déclarations
 *      dont la date/wilaya diffère — 2 déclarations cohérentes = les deux
 *      parties d'un même accident, cas normal B.5).
 *   3. Récurrence de véhicule entre compagnies (même plaque déclarée par
 *      ≥2 compagnies différentes dans une fenêtre temporelle — B.9).
 *   4. Montants calibrés juste sous le plafond IDA (groupement de montants
 *      dans une bande proche du plafond, par compagnie).
 *   5. Incohérences A/B (montant déclaré A vs B > 40% d'écart, ou
 *      wilaya/date discordantes, sur une paire RÉELLEMENT appariée par
 *      MatchingModule).
 *
 * // TODO sprint suivant : enrichir avec les pénalités (CommissionModule) et
 * // les forclusions/silences (RecoursModule) une fois ces modules réels —
 * // hors périmètre de ce sprint (voir consigne de la mission).
 */

export type FraudCaseType = 'DOUBLON' | 'ECONSTAT_REUTILISE' | 'RECURRENCE_VEHICULE' | 'MONTANT_CALIBRE' | 'INCOHERENCE_AB';
export type FraudSeverity = 'FAIBLE' | 'MOYEN' | 'ELEVE';

export interface FraudClaimInput {
  id: string;
  company: string;
  numEconstat?: string;
  plateA?: string;
  wilaya?: string;
  accidentDate?: string;
  estimatedAmount?: number;
  expertAmount?: number;
  createdAt: string;
}

export interface FraudCaseCandidate {
  type: FraudCaseType;
  claimIds: string[];
  companiesInvolved: string[];
  score: number;
  severity: FraudSeverity;
  details: Record<string, unknown>;
}

/** Seuils gravité — pas fixés par le dossier technique (B.9 ne les chiffre pas) : hypothèse documentée. */
export function severityForScore(score: number): FraudSeverity {
  if (score >= 70) return 'ELEVE';
  if (score >= 40) return 'MOYEN';
  return 'FAIBLE';
}

function pushToGroup<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/** 1. Doublons — même compagnie, même plaque A, même jour d'accident, déclarations distinctes. */
export function detectDuplicates(claims: FraudClaimInput[]): FraudCaseCandidate[] {
  const groups = new Map<string, FraudClaimInput[]>();
  for (const c of claims) {
    if (!c.plateA || !c.accidentDate) continue;
    pushToGroup(groups, `${c.company}|${c.plateA}|${c.accidentDate}`, c);
  }
  const cases: FraudCaseCandidate[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const score = Math.min(100, 50 + (group.length - 2) * 15);
    cases.push({
      type: 'DOUBLON',
      claimIds: group.map((c) => c.id),
      companiesInvolved: [...new Set(group.map((c) => c.company))],
      score,
      severity: severityForScore(score),
      details: { plateA: group[0].plateA, accidentDate: group[0].accidentDate, count: group.length },
    });
  }
  return cases;
}

/** 2. E-constat réutilisé sur déclarations divergentes. */
export function detectEconstatReuse(claims: FraudClaimInput[]): FraudCaseCandidate[] {
  const groups = new Map<string, FraudClaimInput[]>();
  for (const c of claims) {
    if (!c.numEconstat) continue;
    pushToGroup(groups, c.numEconstat, c);
  }
  const cases: FraudCaseCandidate[] = [];
  for (const [numEconstat, group] of groups) {
    if (group.length < 2) continue;
    const dates = new Set(group.map((c) => c.accidentDate).filter(Boolean));
    const wilayas = new Set(group.map((c) => c.wilaya).filter(Boolean));
    const divergent = dates.size > 1 || wilayas.size > 1;
    const tooMany = group.length > 2;
    // Exactement 2 déclarations cohérentes = les deux parties du même
    // accident (cas normal d'appariement, B.5) — pas une fraude.
    if (!divergent && !tooMany) continue;
    let score = 30;
    if (tooMany) score += 20 * (group.length - 2);
    if (divergent) score += 30;
    score = Math.min(100, score);
    cases.push({
      type: 'ECONSTAT_REUTILISE',
      claimIds: group.map((c) => c.id),
      companiesInvolved: [...new Set(group.map((c) => c.company))],
      score,
      severity: severityForScore(score),
      details: { numEconstat, count: group.length, datesDistinctes: dates.size, wilayasDistinctes: wilayas.size },
    });
  }
  return cases;
}

/** 3. Récurrence de véhicule entre compagnies, dans une fenêtre temporelle. */
export function detectVehicleRecurrence(claims: FraudClaimInput[], windowDays = 90): FraudCaseCandidate[] {
  const byPlate = new Map<string, FraudClaimInput[]>();
  for (const c of claims) {
    if (!c.plateA) continue;
    pushToGroup(byPlate, c.plateA, c);
  }
  const cases: FraudCaseCandidate[] = [];
  for (const [plate, group] of byPlate) {
    const companies = new Set(group.map((c) => c.company));
    if (companies.size < 2) continue;

    let withinWindow = false;
    outer: for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].company === group[j].company) continue;
        if (!group[i].accidentDate || !group[j].accidentDate) continue;
        const diffDays = Math.abs(new Date(group[j].accidentDate as string).getTime() - new Date(group[i].accidentDate as string).getTime()) / 86_400_000;
        if (diffDays <= windowDays) {
          withinWindow = true;
          break outer;
        }
      }
    }
    if (!withinWindow) continue;

    const score = Math.min(100, 40 + (companies.size - 2) * 20);
    cases.push({
      type: 'RECURRENCE_VEHICULE',
      claimIds: group.map((c) => c.id),
      companiesInvolved: [...companies],
      score,
      severity: severityForScore(score),
      details: { plateA: plate, companiesCount: companies.size, windowDays },
    });
  }
  return cases;
}

/** 4. Montants calibrés juste sous le plafond IDA, groupés par compagnie. */
export function detectCalibratedAmounts(claims: FraudClaimInput[], ceiling: number, bandRatio = 0.9, minCount = 3): FraudCaseCandidate[] {
  const byCompany = new Map<string, FraudClaimInput[]>();
  for (const c of claims) {
    const amount = c.expertAmount ?? c.estimatedAmount;
    if (amount === undefined) continue;
    if (amount < ceiling * bandRatio || amount >= ceiling) continue;
    pushToGroup(byCompany, c.company, c);
  }
  const cases: FraudCaseCandidate[] = [];
  for (const [company, group] of byCompany) {
    if (group.length < minCount) continue;
    const score = Math.min(100, 40 + (group.length - minCount) * 10);
    cases.push({
      type: 'MONTANT_CALIBRE',
      claimIds: group.map((c) => c.id),
      companiesInvolved: [company],
      score,
      severity: severityForScore(score),
      details: { company, count: group.length, bandMin: ceiling * bandRatio, bandMax: ceiling },
    });
  }
  return cases;
}

/** Paire RÉELLEMENT appariée (MatchingModule) avec les montants/wilaya/date des DEUX déclarations. */
export interface MatchedPairAmounts {
  claimAId: string;
  claimBId: string;
  companyA: string;
  companyB: string;
  amountA?: number;
  amountB?: number;
  wilayaA?: string;
  wilayaB?: string;
  dateA?: string;
  dateB?: string;
}

/** 5. Incohérences A/B sur une paire réellement appariée. */
export function detectAbInconsistencies(pairs: MatchedPairAmounts[], amountDiffThreshold = 0.4): FraudCaseCandidate[] {
  const cases: FraudCaseCandidate[] = [];
  for (const p of pairs) {
    if (p.amountA === undefined || p.amountB === undefined) continue;
    const maxAmount = Math.max(p.amountA, p.amountB);
    if (maxAmount <= 0) continue;
    const diffRatio = Math.abs(p.amountA - p.amountB) / maxAmount;
    const wilayaMismatch = !!p.wilayaA && !!p.wilayaB && p.wilayaA !== p.wilayaB;
    const dateMismatch = !!p.dateA && !!p.dateB && p.dateA !== p.dateB;
    if (diffRatio <= amountDiffThreshold && !wilayaMismatch && !dateMismatch) continue;

    let score = 0;
    if (diffRatio > amountDiffThreshold) score += 50;
    if (wilayaMismatch) score += 25;
    if (dateMismatch) score += 25;
    score = Math.min(100, score);

    cases.push({
      type: 'INCOHERENCE_AB',
      claimIds: [p.claimAId, p.claimBId],
      companiesInvolved: [p.companyA, p.companyB],
      score,
      severity: severityForScore(score),
      details: { amountA: p.amountA, amountB: p.amountB, diffRatio: Math.round(diffRatio * 1000) / 1000, wilayaMismatch, dateMismatch },
    });
  }
  return cases;
}
