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
 * ⚠️ Branchées depuis la réconciliation sprint 3 (voir HANDOFF.md) —
 * `silences`/`oppositions` à partir de `RecoursModule` (champ `resolution.kind`
 * de la machine d'état), `penalites` à partir de `CommissionModule`
 * (`SanctionViewDto`) :
 *   - silences : taux de recours REÇUS (compagnie = `to`) résolus par
 *     silence (`ACCEPTATION_TACITE_ART10`) parmi ceux déjà résolus —
 *     **hypothèse** : seuls les recours ayant une `resolution` sont comptés
 *     (ceux encore `EN_ATTENTE` sans issue ne sont pas des "silences" tant
 *     que le délai Art.10 n'a pas expiré).
 *   - oppositions : taux d'oppositions REÇUES PAR LA COMPAGNIE ADVERSE mais
 *     dont la contestation de la compagnie demanderesse (`from`) n'a jamais
 *     été suivie d'effet (`OPPOSITION_FONDEE_ART12` — expirée faute de
 *     transmission en commission), parmi les recours de cette compagnie
 *     ayant fait l'objet d'une opposition et déjà sortis de l'état brut
 *     `OPPOSITION` — **hypothèse** : mesure l'engagement de la compagnie
 *     demanderesse face à une opposition, pas la légitimité de ses recours
 *     eux-mêmes (non calculable sans arbitrage humain) — à valider avec le
 *     métier.
 *   - penalites : score dégressif selon le nombre de sanctions
 *     (`CommissionModule`) prononcées contre la compagnie, tous types
 *     confondus — **hypothèse** : 20 points retirés par sanction (plancher
 *     0), barème non chiffré par le dossier technique, à valider avec
 *     l'UAR.
 * Si aucune donnée pertinente n'existe pour une compagnie : `null` (jamais
 * une valeur inventée), `dataSource: 'NON_DISPONIBLE'`. Le score composite
 * est recalculé sur les seules composantes disponibles, pondérations
 * renormalisées (documenté dans `computeCompositeScore`).
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
  grade: 'A' | 'B' | 'C' | 'D' | null;
  rank: number;
  details: Record<MonitoringComponentKey, MonitoringComponentValue>;
  profile: MonitoringCompanyProfile;
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

export interface RecoursMonitoringInput {
  from: string;
  to: string;
  state: string;
  opposition?: unknown;
  contestation?: unknown;
  resolutionKind?: string;
  requestSentAt?: string;
  responseAt?: string;
}

/** silences — voir hypothèse en tête de fichier. */
export function computeSilencesScore(recours: RecoursMonitoringInput[], company: string): MonitoringComponentValue {
  const resolved = recours.filter((r) => r.to === company && r.resolutionKind);
  if (resolved.length === 0) return { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 };
  const silences = resolved.filter((r) => r.resolutionKind === 'ACCEPTATION_TACITE_ART10').length;
  const score = ((resolved.length - silences) / resolved.length) * 100;
  return { value: Math.round(score * 10) / 10, dataSource: 'REEL', sampleSize: resolved.length };
}

/** oppositions — voir hypothèse en tête de fichier. */
export function computeOppositionsScore(recours: RecoursMonitoringInput[], company: string): MonitoringComponentValue {
  const challenged = recours.filter((r) => r.from === company && r.opposition && r.state !== 'OPPOSITION');
  if (challenged.length === 0) return { value: null, dataSource: 'NON_DISPONIBLE', sampleSize: 0 };
  const unresolved = challenged.filter((r) => r.resolutionKind === 'OPPOSITION_FONDEE_ART12').length;
  const score = ((challenged.length - unresolved) / challenged.length) * 100;
  return { value: Math.round(score * 10) / 10, dataSource: 'REEL', sampleSize: challenged.length };
}

/** Points retirés par sanction (tous types confondus) — hypothèse non chiffrée par le dossier, voir tête de fichier. */
export const PENALTY_POINTS_PER_SANCTION = 20;

/** penalites — voir hypothèse en tête de fichier. "Aucune sanction" est une donnée réelle (score 100), pas une absence de donnée. */
export function computePenalitesScore(sanctionCountByCompany: Map<string, number>, company: string): MonitoringComponentValue {
  const count = sanctionCountByCompany.get(company) ?? 0;
  const score = Math.max(0, 100 - count * PENALTY_POINTS_PER_SANCTION);
  return { value: score, dataSource: 'REEL', sampleSize: count };
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

/**
 * Note lettrée (écran 8, guide illustré) — endpoint additif, dérivée
 * UNIQUEMENT pour l'affichage (aucune règle de conformité recodée, le score
 * composite ci-dessus reste la seule donnée de référence). Seuils **hypothèse
 * non chiffrée par le dossier technique** (calée sur l'exemple du guide :
 * 73 → B, 71 → C), à valider avec l'UAR avant mise en production.
 */
export const GRADE_THRESHOLDS = { A: 90, B: 72, C: 50 } as const;

/** Seuil d'alerte "oppositions fréquentes" (guide illustré, §6.8) — hypothèse non chiffrée par le dossier technique, à valider avec l'UAR. */
export const OPPOSITION_ALERT_THRESHOLD_PCT = 20;

export function gradeFromScore(score: number | null): 'A' | 'B' | 'C' | 'D' | null {
  if (score === null) return null;
  if (score >= GRADE_THRESHOLDS.A) return 'A';
  if (score >= GRADE_THRESHOLDS.B) return 'B';
  if (score >= GRADE_THRESHOLDS.C) return 'C';
  return 'D';
}

/**
 * Profil détaillé par compagnie (écran 8, guide illustré — tuiles + colonnes
 * de taux bruts) — endpoint additif, COMPLÈTE `details` ci-dessus (scores
 * normalisés 0-100 pour le composite) sans le remplacer : ici, des COMPTES
 * et TAUX BRUTS réels, dans le sens d'affichage du guide (ex. "Silences"
 * est un taux brut de silences, pas l'inverse du score de conformité).
 *
 * ⚠️ `onTimeResponsePct`/`avgResponseDays` réutilisent `silenceDays`
 * (`RecoursService.getTimerConfig()`, Art.10 — 30 j par défaut, PAS les
 * "10 j" affichés tels quels dans le guide illustré) : le guide semble
 * utiliser une fenêtre différente, mais dupliquer une seconde constante de
 * délai Art.10 dans ce module créerait une incohérence interne avec le
 * RecoursModule — le libellé front affiche la vraie valeur configurée.
 */
export interface MonitoringCompanyProfile {
  /** % de recours REÇUS (to=compagnie) répondus EXPLICITEMENT dans le délai Art.10 configuré (silence exclu : un silence n'est pas "à temps", voir hypothèse ci-dessus). */
  onTimeResponsePct: number | null;
  /** Délai moyen de réponse explicite (jours), recours reçus avec `responseAt`. */
  avgResponseDays: number | null;
  /** Recours ÉMIS (from=compagnie) ayant fait l'objet d'une opposition de la partie adverse. */
  oppositionsEmisesCount: number;
  /** Recours REÇUS (to=compagnie) sur lesquels la compagnie a levé une opposition. */
  oppositionsSubiesCount: number;
  /** Recours REÇUS résolus par silence Art.10 (acceptation tacite). */
  silencesCount: number;
  /** Recours ÉMIS sur lesquels la compagnie a contesté l'opposition reçue (transmission commission). */
  contestationsCount: number;
  /** Recours (émis OU reçus) forclos (Art.19). */
  forclosCount: number;
  /** Taux brut de silences parmi les recours reçus déjà résolus (PAS l'inverse du score `silences` du composite). */
  silencesRatePct: number | null;
  /** Taux brut d'oppositions reçues parmi les recours émis (PAS l'inverse du score `oppositions` du composite). */
  oppositionsRatePct: number | null;
}

export function computeMonitoringProfile(recours: RecoursMonitoringInput[], company: string, silenceDays: number): MonitoringCompanyProfile {
  const received = recours.filter((r) => r.to === company);
  const resolvedReceived = received.filter((r) => r.resolutionKind);
  const silences = resolvedReceived.filter((r) => r.resolutionKind === 'ACCEPTATION_TACITE_ART10');
  const explicitResponses = received.filter((r) => r.responseAt && r.requestSentAt);

  const responseDelays = explicitResponses.map((r) => {
    const sent = new Date(r.requestSentAt!).getTime();
    const resp = new Date(r.responseAt!).getTime();
    return (resp - sent) / 86_400_000;
  });
  const onTimeCount = responseDelays.filter((d) => d <= silenceDays).length;
  const onTimeResponsePct = resolvedReceived.length > 0 ? Math.round(((onTimeCount) / resolvedReceived.length) * 1000) / 10 : null;
  const avgResponseDays =
    responseDelays.length > 0 ? Math.round((responseDelays.reduce((s, v) => s + v, 0) / responseDelays.length) * 10) / 10 : null;

  const emitted = recours.filter((r) => r.from === company);
  const oppositionsEmisesCount = emitted.filter((r) => r.opposition).length;
  const oppositionsSubiesCount = received.filter((r) => r.opposition).length;
  const contestationsCount = emitted.filter((r) => r.contestation).length;
  const forclosCount = recours.filter((r) => (r.from === company || r.to === company) && r.resolutionKind === 'FORCLUSION_ART19').length;

  return {
    onTimeResponsePct,
    avgResponseDays,
    oppositionsEmisesCount,
    oppositionsSubiesCount,
    silencesCount: silences.length,
    contestationsCount,
    forclosCount,
    silencesRatePct: resolvedReceived.length > 0 ? Math.round((silences.length / resolvedReceived.length) * 1000) / 10 : null,
    oppositionsRatePct: emitted.length > 0 ? Math.round((oppositionsEmisesCount / emitted.length) * 1000) / 10 : null,
  };
}
