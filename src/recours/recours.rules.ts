/**
 * Règles métier du RecoursModule — B.2/B.3, écran 4 "Échanges Annexes 2/3/4".
 *
 * Fonctions PURES (aucune I/O, aucune dépendance Nest/MikroORM) afin d'être
 * unitairement testables sans contexte Nest ni base de données — même
 * esprit que `eligibility.rules.ts` / `matching.scoring.ts` (sprint 2).
 *
 * Articles couverts :
 *  - Art. 10 : silence de la compagnie adverse pendant `silenceDays` jours
 *    après l'envoi du recours (Annexe 2) = acceptation TACITE.
 *  - Art. 12 : opposition non traitée dans les `oppositionDays` jours =
 *    réputée FONDÉE (le recours échoue par défaut, faute de traitement).
 *  - Art. 19 : délai global de forclusion, réutilisant la même notion de
 *    délai que `EligibilityModule` (`recoursMaxMonths`/
 *    `ELIGIBILITY_RECOURS_MAX_MONTHS`, cohérence demandée par la mission),
 *    décompté depuis l'envoi du recours (`requestSentAt`).
 *
 * ⚠️ HYPOTHÈSE À VALIDER PAR LE MÉTIER (documentée aussi dans HANDOFF.md) :
 * le dossier technique cite les articles 10/12/19 mais ne fixe pas la durée
 * exacte des délais Art.10 (silence) et Art.12 (opposition) — seul le délai
 * de forclusion de 6 mois (Art.19) est donné en B.6 pour l'éligibilité. Les
 * valeurs par défaut ci-dessous (30 jours / 15 jours) sont des conventions
 * de place plausibles, PARAMÉTRABLES par variable d'environnement (voir
 * `RecoursService`), à confirmer avec le métier avant mise en production.
 */

export const RECOURS_STATES = [
  'EN_ATTENTE',
  'OPPOSITION',
  'CONTESTATION',
  'COMMISSION',
  'REGLE',
  'REJETE',
  'FORCLOS',
] as const;
export type RecoursState = (typeof RECOURS_STATES)[number];

/** États terminaux : plus aucun timer, plus aucune transition possible. */
export const RECOURS_TERMINAL_STATES: RecoursState[] = ['REGLE', 'REJETE', 'FORCLOS'];

export type OppositionStatus = 'EN_COURS' | 'FONDEE_TACITE' | 'REJETEE';
export type ContestationStatus = 'EN_COURS' | 'TRANSMISE_COMMISSION';

export interface OppositionInfo {
  raisedAt: string;
  reason?: string;
  /** Code du motif d'opposition (référentiel `OppositionMotif`), optionnel. */
  reasonCode?: string;
  status: OppositionStatus;
  /** Échéance Art.12 : au-delà, opposition réputée fondée si non traitée. */
  deadlineAt: string;
  decidedAt?: string;
}

export interface ContestationInfo {
  raisedAt: string;
  reason?: string;
  status: ContestationStatus;
}

export type ResolutionKind =
  | 'ACCEPTATION_TACITE_ART10'
  | 'ACCEPTATION_EXPRESSE'
  | 'OPPOSITION_FONDEE_ART12'
  | 'OPPOSITION_LEVEE'
  | 'DECISION_COMMISSION_FAVORABLE'
  | 'DECISION_COMMISSION_DEFAVORABLE'
  | 'FORCLUSION_ART19';

export interface ResolutionInfo {
  kind: ResolutionKind;
  at: string;
  note?: string;
}

/**
 * Snapshot minimal nécessaire pour calculer timers/transitions — indépendant
 * de MikroORM (le service convertit l'entité/la ligne mémoire vers/depuis
 * cette forme, voir `recours.service.ts`).
 */
export interface RecoursSnapshot {
  state: RecoursState;
  requestSentAt: string;
  responseAt?: string;
  opposition?: OppositionInfo;
  contestation?: ContestationInfo;
  commissionAt?: string;
  settledAt?: string;
  resolution?: ResolutionInfo;
}

export interface RecoursTimerConfig {
  /** Art. 10 — silence = acceptation tacite, en jours depuis `requestSentAt`. */
  silenceDays: number;
  /** Art. 12 — opposition non traitée = réputée fondée, en jours depuis `opposition.raisedAt`. */
  oppositionDays: number;
  /** Art. 19 — forclusion globale, en MOIS depuis `requestSentAt` (cohérent avec ELIGIBILITY_RECOURS_MAX_MONTHS). */
  forclusionMonths: number;
}

export const DEFAULT_RECOURS_TIMER_CONFIG: RecoursTimerConfig = {
  silenceDays: 30,
  oppositionDays: 15,
  forclusionMonths: 6,
};

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Ajoute `months` mois à une date, en arithmétique calendaire (UTC, sans dérive de fuseau) — même logique que eligibility.rules.ts. */
export function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

export type TimerType = 'SILENCE_ART10' | 'OPPOSITION_ART12' | 'FORCLUSION_ART19' | 'AUCUN';

/** Forme consommée par le front pour sa `countdownBar` — aucun calcul de délai côté front (C.1). */
export interface TimerState {
  timerType: TimerType;
  deadlineAt?: string;
  remainingMs: number;
  remainingDays: number;
  expired: boolean;
}

/**
 * Calcule le timer conventionnel actif pour `countdownBar` (front). Une
 * seule échéance affichée à la fois : la plus proche entre le timer propre à
 * l'état courant (Art.10 ou Art.12) et l'échéance globale de forclusion
 * (Art.19), qui prime toujours en cas d'égalité (elle met fin au recours
 * quel que soit son sous-état).
 */
export function computeTimerState(
  snapshot: RecoursSnapshot,
  now: Date,
  config: RecoursTimerConfig = DEFAULT_RECOURS_TIMER_CONFIG,
): TimerState {
  if (RECOURS_TERMINAL_STATES.includes(snapshot.state)) {
    return { timerType: 'AUCUN', remainingMs: 0, remainingDays: 0, expired: false };
  }

  const sentAt = new Date(snapshot.requestSentAt);
  const forclusionDeadline = addMonthsUtc(sentAt, config.forclusionMonths);

  let candidate: { timerType: TimerType; deadlineAt: Date } = {
    timerType: 'FORCLUSION_ART19',
    deadlineAt: forclusionDeadline,
  };

  if (snapshot.state === 'EN_ATTENTE') {
    const silenceDeadline = addDaysUtc(sentAt, config.silenceDays);
    if (silenceDeadline.getTime() <= forclusionDeadline.getTime()) {
      candidate = { timerType: 'SILENCE_ART10', deadlineAt: silenceDeadline };
    }
  } else if (snapshot.state === 'OPPOSITION' && snapshot.opposition?.status === 'EN_COURS') {
    const oppositionDeadline = addDaysUtc(new Date(snapshot.opposition.raisedAt), config.oppositionDays);
    if (oppositionDeadline.getTime() <= forclusionDeadline.getTime()) {
      candidate = { timerType: 'OPPOSITION_ART12', deadlineAt: oppositionDeadline };
    }
  }
  // CONTESTATION / COMMISSION : aucun sous-délai propre donné par le dossier
  // technique — seule l'échéance globale de forclusion (Art.19) s'applique.

  const remainingMs = candidate.deadlineAt.getTime() - now.getTime();
  return {
    timerType: candidate.timerType,
    deadlineAt: candidate.deadlineAt.toISOString(),
    remainingMs,
    remainingDays: Math.ceil(remainingMs / 86_400_000),
    expired: remainingMs <= 0,
  };
}

export interface AutomaticTransitionResult {
  changed: boolean;
  snapshot: RecoursSnapshot;
}

/**
 * Applique, de façon PURE, les transitions AUTOMATIQUES déclenchées par le
 * dépassement d'un timer conventionnel (Art.10 silence, Art.12 opposition
 * non traitée) ou de la forclusion globale (Art.19). Appelée paresseusement
 * (lazy) par `RecoursService` à chaque lecture/écriture d'un recours, faute
 * d'ordonnanceur (cron) dans ce sprint — voir HANDOFF.md pour la limite
 * connue et la piste d'amélioration (job planifié + émission périodique de
 * `recours.timer`).
 */
export function applyAutomaticTransitions(
  snapshot: RecoursSnapshot,
  now: Date,
  config: RecoursTimerConfig = DEFAULT_RECOURS_TIMER_CONFIG,
): AutomaticTransitionResult {
  if (RECOURS_TERMINAL_STATES.includes(snapshot.state)) {
    return { changed: false, snapshot };
  }

  const sentAt = new Date(snapshot.requestSentAt);
  const forclusionDeadline = addMonthsUtc(sentAt, config.forclusionMonths);
  const nowIso = now.toISOString();

  // Art. 19 — priorité absolue : dépassé, peu importe le sous-état courant.
  if (now.getTime() > forclusionDeadline.getTime()) {
    return {
      changed: true,
      snapshot: { ...snapshot, state: 'FORCLOS', resolution: { kind: 'FORCLUSION_ART19', at: nowIso } },
    };
  }

  if (snapshot.state === 'EN_ATTENTE') {
    const silenceDeadline = addDaysUtc(sentAt, config.silenceDays);
    if (now.getTime() > silenceDeadline.getTime()) {
      return {
        changed: true,
        snapshot: {
          ...snapshot,
          state: 'REGLE',
          responseAt: snapshot.responseAt ?? nowIso,
          resolution: { kind: 'ACCEPTATION_TACITE_ART10', at: nowIso },
          settledAt: nowIso,
        },
      };
    }
  } else if (snapshot.state === 'OPPOSITION' && snapshot.opposition?.status === 'EN_COURS') {
    const oppositionDeadline = addDaysUtc(new Date(snapshot.opposition.raisedAt), config.oppositionDays);
    if (now.getTime() > oppositionDeadline.getTime()) {
      return {
        changed: true,
        snapshot: {
          ...snapshot,
          state: 'REJETE',
          opposition: { ...snapshot.opposition, status: 'FONDEE_TACITE', decidedAt: nowIso },
          resolution: { kind: 'OPPOSITION_FONDEE_ART12', at: nowIso },
        },
      };
    }
  }

  return { changed: false, snapshot };
}

export const RECOURS_ACTIONS = [
  'accepter',
  'opposer',
  'lever_opposition',
  'contester',
  'transmettre_commission',
  'cloturer_commission_favorable',
  'cloturer_commission_defavorable',
] as const;
export type RecoursAction = (typeof RECOURS_ACTIONS)[number];

/** Transitions manuelles autorisées par état courant — validation humaine obligatoire (même esprit que l'Art.14 du matching). */
const ALLOWED_ACTIONS_BY_STATE: Record<RecoursState, RecoursAction[]> = {
  EN_ATTENTE: ['accepter', 'opposer'],
  OPPOSITION: ['lever_opposition', 'contester'],
  CONTESTATION: ['transmettre_commission'],
  COMMISSION: ['cloturer_commission_favorable', 'cloturer_commission_defavorable'],
  REGLE: [],
  REJETE: [],
  FORCLOS: [],
};

export function isActionAllowed(state: RecoursState, action: RecoursAction): boolean {
  return ALLOWED_ACTIONS_BY_STATE[state]?.includes(action) ?? false;
}

/**
 * Applique une transition MANUELLE (décision humaine). Renvoie `null` si
 * l'action n'est pas autorisée dans l'état courant (le service traduit
 * alors en `BadRequestException`) — ne modifie jamais un recours déjà dans
 * un état terminal (`isActionAllowed` renvoie toujours `false` pour ceux-ci).
 */
export function applyManualTransition(
  snapshot: RecoursSnapshot,
  action: RecoursAction,
  now: Date,
  config: RecoursTimerConfig = DEFAULT_RECOURS_TIMER_CONFIG,
  opts: { reason?: string; reasonCode?: string } = {},
): RecoursSnapshot | null {
  if (!isActionAllowed(snapshot.state, action)) return null;
  const nowIso = now.toISOString();

  switch (action) {
    case 'accepter':
      return {
        ...snapshot,
        state: 'REGLE',
        responseAt: nowIso,
        resolution: { kind: 'ACCEPTATION_EXPRESSE', at: nowIso },
        settledAt: nowIso,
      };
    case 'opposer':
      return {
        ...snapshot,
        state: 'OPPOSITION',
        responseAt: nowIso,
        opposition: {
          raisedAt: nowIso,
          reason: opts.reason,
          ...(opts.reasonCode ? { reasonCode: opts.reasonCode } : {}),
          status: 'EN_COURS',
          deadlineAt: addDaysUtc(now, config.oppositionDays).toISOString(),
        },
      };
    case 'lever_opposition':
      return {
        ...snapshot,
        state: 'REGLE',
        opposition: snapshot.opposition
          ? { ...snapshot.opposition, status: 'REJETEE', decidedAt: nowIso }
          : snapshot.opposition,
        resolution: { kind: 'OPPOSITION_LEVEE', at: nowIso },
        settledAt: nowIso,
      };
    case 'contester':
      return {
        ...snapshot,
        state: 'CONTESTATION',
        contestation: { raisedAt: nowIso, reason: opts.reason, status: 'EN_COURS' },
      };
    case 'transmettre_commission':
      return {
        ...snapshot,
        state: 'COMMISSION',
        commissionAt: nowIso,
        contestation: snapshot.contestation
          ? { ...snapshot.contestation, status: 'TRANSMISE_COMMISSION' }
          : snapshot.contestation,
      };
    case 'cloturer_commission_favorable':
      return {
        ...snapshot,
        state: 'REGLE',
        resolution: { kind: 'DECISION_COMMISSION_FAVORABLE', at: nowIso, note: opts.reason },
        settledAt: nowIso,
      };
    case 'cloturer_commission_defavorable':
      return {
        ...snapshot,
        state: 'REJETE',
        resolution: { kind: 'DECISION_COMMISSION_DEFAVORABLE', at: nowIso, note: opts.reason },
      };
    default:
      // Exhaustif par construction (RECOURS_ACTIONS) — ne devrait jamais être atteint.
      throw new Error(`Action de transition recours non gérée: ${action as string}`);
  }
}

export type RecoursJourneyStepKind = 'annexe2' | 'annexe3' | 'annexe4' | 'commission' | 'resolution';

export interface RecoursJourneyStep {
  key: RecoursJourneyStepKind;
  at: string;
}

/**
 * Parcours RÉEL d'un recours — mêmes étapes que `buildTimeline` (front,
 * `exchanges/page.tsx`), reconstruites ici pour `MonitoringService`
 * ("Vue par dossier — parcours complet", écran 8 guide illustré).
 *
 * ⚠️ Le guide illustré montre un nombre d'étapes fixe par parcours (8 ou
 * 11) qui ressemble à une taxonomie procédurale détaillée des Annexes
 * 2/3/4 — AUCUNE définition de ces étapes n'existe dans le dossier
 * technique. Plutôt que d'inventer des étapes non documentées pour
 * reproduire ces chiffres, cette fonction retourne les SEULES étapes
 * réellement persistées : la longueur varie donc avec l'historique réel du
 * recours (1 à 5 étapes), pas un compte fixe de 8/11.
 */
export function buildRecoursJourneySteps(snapshot: RecoursSnapshot): RecoursJourneyStep[] {
  const steps: RecoursJourneyStep[] = [{ key: 'annexe2', at: snapshot.requestSentAt }];
  if (snapshot.opposition) steps.push({ key: 'annexe3', at: snapshot.opposition.raisedAt });
  if (snapshot.contestation) steps.push({ key: 'annexe4', at: snapshot.contestation.raisedAt });
  if (snapshot.commissionAt) steps.push({ key: 'commission', at: snapshot.commissionAt });
  if (snapshot.resolution) steps.push({ key: 'resolution', at: snapshot.resolution.at });
  return steps.sort((a, b) => a.at.localeCompare(b.at));
}
