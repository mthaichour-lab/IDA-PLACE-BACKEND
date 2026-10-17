/**
 * MonitoringModule — écran 8 "Monitoring assureurs", B.2. Fonctions PURES
 * (aucune I/O, aucune dépendance Nest) pour le calcul composite — mêmes
 * raisons que `eligibility.rules.ts`/`matching.scoring.ts` (testable sans
 * Nest ni base de données).
 *
 * Pondérations réelles du dossier technique (B.2 écran 8), inchangées :
 *   délais 30% · silences 15% · oppositions 15% · qualité données 15% ·
 *   forclusions 10% · demandes tardives 10% · pénalités 5%.
 *
 * ⚠️ Composantes RÉELLEMENT calculables dans ce sprint, à partir des seules
 * données disponibles dans ce worktree (ClaimsModule/EligibilityModule/
 * MatchingModule) :
 *   - qualiteDonnees : taux de dossiers importés SANS erreur de format
 *     (`eligibilityReasons` ne contient aucun motif préfixé
 *     "Erreur de format :", voir claims.service.ts).
 *   - forclusions : taux de dossiers dont le motif d'inéligibilité contient
 *     "forclusion" (Art. 19, déjà calculé par EligibilityModule — voir
 *     eligibility.rules.ts, ligne "forclusion, Art. 19").
 *   - demandesTardives : taux de dossiers dont la demande de recours a été
 *     introduite tardivement (plus de la moitié du délai autorisé après
 *     l'accident) MAIS pas encore forclose — hypothèse documentée,
 *     paramétrable (voir `TARDIF_RATIO_THRESHOLD`).
 *   - delais : latence réelle moyenne (en jours) entre la date de
 *     l'accident et la date d'ingestion du dossier dans la place
 *     (`createdAt` de `Claim`) — PAS la définition complète du dossier
 *     technique (qui inclut probablement les délais de règlement/recours),
 *     mais la seule latence réellement mesurable aujourd'hui. Documenté.
 *
 * ⚠️ Composantes TOUJOURS PAS branchées (`RecoursModule`/`CommissionModule`
 * sont réels depuis ce même sprint, mais dans un autre worktree — ce fichier
 * n'a pas été mis à jour pour les consommer, pas parce que les données
 * restent indisponibles ; voir revue Product Owner, sprint 3, et HANDOFF.md
 * pour le TODO exact du prochain agent Backend) :
 *   - silences (silence d'une compagnie à une relance de recours)
 *   - oppositions (opposition formelle à un recours)
 *   - penalites (pénalités prononcées, CommissionModule)
 * Pour ces 3 composantes : `null` (jamais une valeur inventée), avec un
 * drapeau explicite `dataSource: 'NON_DISPONIBLE'` par composante (voir
 * `monitoring.service.ts`). Le score composite est recalculé sur les seules
 * composantes disponibles, pondérations renormalisées (documenté dans
 * `computeCompositeScore`).
 * // TODO sprint suivant : brancher silences/oppositions sur RecoursModule
 * // et pénalités sur CommissionModule une fois ces modules réels.
 */

export const MONITORING_WEIGHTS = {
  delais: 0.3,
  silences: 0.15,
  oppositions: 0.15,
  qualiteDonnees: 0.15,
  forclusions: 0.1,
  demandesTardives: 0.1,
  penalites: 0.05,
} as const;

export type MonitoringComponentKey = keyof typeof MONITORING_WEIGHTS;

/** Composantes réellement calculables dans ce sprint (voir doc de fichier). */
export const REAL_COMPONENTS: MonitoringComponentKey[] = ['delais', 'qualiteDonnees', 'forclusions', 'demandesTardives'];
/** Composantes non disponibles (dépendent de Recours/CommissionModule, hors périmètre). */
export const PLACEHOLDER_COMPONENTS: MonitoringComponentKey[] = ['silences', 'oppositions', 'penalites'];

/** Chaque jour de latence au-delà de 0 retire ce nombre de points (plancher 0) — hypothèse documentée, paramétrable. */
export const DELAY_PENALTY_PER_DAY = 2;

/** Ratio (temps écoulé / délai de recours autorisé) au-delà duquel une demande est jugée "tardive" mais pas forclose. */
export const TARDIF_RATIO_THRESHOLD = 0.5;

export interface ClaimMonitoringInput {
  company: string;
  accidentDate?: string;
  createdAt: string;
  eligibilityVerdict?: string;
  eligibilityReasons?: string[];
  dateDemandeRecours?: string;
}

export interface MonitoringComponentValue {
  value: number | null;
  dataSource: 'REEL' | 'NON_DISPONIBLE';
  sampleSize: number;
}

export interface MonitoringCompanyResult {
  code: string;
  score: number | null;
  rank: number;
  details: Record<MonitoringComponentKey, MonitoringComponentValue>;
}

/** Écart en jours CALENDAIRES (UTC, heure ignorée) — un accident et une ingestion le même jour civil comptent pour 0 jour de latence, quelle que soit l'heure. */
function daysBetween(a: Date, b: Date): number {
  const dayA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const dayB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.abs(dayA - dayB) / 86_400_000;
}

function toDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** délais — moyenne (jours accident → ingestion) mappée sur 0-100 (0 jour = 100, plancher 0). */
export function computeDelaisScore(claims: ClaimMonitoringInput[]): MonitoringComponentValue {
  const samples = claims
    .map((c) => {
      const accident = toDate(c.accidentDate);
      const created = toDate(c.createdAt);
      if (!accident || !created) return undefined;
      return daysBetween(accident, created);
    })
    .filter((v): v is number => v !== undefined);

  if (samples.length === 0) return { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 };
  const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
  const score = Math.max(0, Math.min(100, 100 - avg * DELAY_PENALTY_PER_DAY));
  return { value: Math.round(score * 10) / 10, dataSource: 'REEL', sampleSize: samples.length };
}

/** qualiteDonnees — % de dossiers sans erreur de format à l'import. */
export function computeQualiteDonneesScore(claims: ClaimMonitoringInput[]): MonitoringComponentValue {
  if (claims.length === 0) return { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 };
  const withErrors = claims.filter((c) => (c.eligibilityReasons ?? []).some((r) => r.startsWith('Erreur de format'))).length;
  const score = ((claims.length - withErrors) / claims.length) * 100;
  return { value: Math.round(score * 10) / 10, dataSource: 'REEL', sampleSize: claims.length };
}

/** forclusions — 100 - % de dossiers forclos (Art. 19, motif déjà calculé par EligibilityModule). */
export function computeForclusionsScore(claims: ClaimMonitoringInput[]): MonitoringComponentValue {
  if (claims.length === 0) return { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 };
  const forclos = claims.filter((c) => (c.eligibilityReasons ?? []).some((r) => r.toLowerCase().includes('forclusion'))).length;
  const score = ((claims.length - forclos) / claims.length) * 100;
  return { value: Math.round(score * 10) / 10, dataSource: 'REEL', sampleSize: claims.length };
}

/**
 * demandesTardives — 100 - % de dossiers dont la demande de recours a
 * utilisé plus de `TARDIF_RATIO_THRESHOLD` du délai autorisé (Art. 19,
 * `recoursMaxMonths`), sans être forclose (déjà compté par ailleurs).
 */
export function computeDemandesTardivesScore(claims: ClaimMonitoringInput[], recoursMaxMonths: number): MonitoringComponentValue {
  const eligible = claims.filter((c) => c.accidentDate && c.dateDemandeRecours);
  if (eligible.length === 0) return { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 };

  const maxDays = recoursMaxMonths * 30; // approximation calendaire simple, cohérente avec le seuil (pas un calcul de forclusion exact — voir eligibility.rules.ts pour celui-ci)
  const tardives = eligible.filter((c) => {
    const accident = toDate(c.accidentDate);
    const recours = toDate(c.dateDemandeRecours);
    if (!accident || !recours) return false;
    const elapsed = daysBetween(accident, recours);
    const forclos = (c.eligibilityReasons ?? []).some((r) => r.toLowerCase().includes('forclusion'));
    return !forclos && elapsed / maxDays > TARDIF_RATIO_THRESHOLD;
  }).length;

  const score = ((eligible.length - tardives) / eligible.length) * 100;
  return { value: Math.round(score * 10) / 10, dataSource: 'REEL', sampleSize: eligible.length };
}

/**
 * Score composite — moyenne pondérée des SEULES composantes disponibles
 * (pondérations renormalisées pour sommer à 1), jamais une composante
 * manquante comptée comme 0 (ce qui pénaliserait injustement une compagnie
 * faute de données, plutôt que faute de conformité réelle). `null` si
 * aucune composante n'est disponible.
 */
export function computeCompositeScore(details: Record<MonitoringComponentKey, MonitoringComponentValue>): number | null {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of Object.keys(MONITORING_WEIGHTS) as MonitoringComponentKey[]) {
    const v = details[key];
    if (v.value === null) continue;
    weightedSum += v.value * MONITORING_WEIGHTS[key];
    weightTotal += MONITORING_WEIGHTS[key];
  }
  if (weightTotal === 0) return null;
  return Math.round((weightedSum / weightTotal) * 10) / 10;
}
