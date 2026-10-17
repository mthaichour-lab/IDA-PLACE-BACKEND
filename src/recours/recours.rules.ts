/**
 * Machine à états + timers conventionnels — RecoursModule, B.2/B.3 (écran 4,
 * "Échanges Annexes 2/3/4"). Fonctions PURES (aucune I/O, aucune dépendance
 * Nest), sur le même modèle que `eligibility.rules.ts`/`matching.scoring.ts` :
 * testables sans contexte Nest ni base de données. `RecoursService` n'est
 * qu'une fine couche injectable (persistance, repli mémoire, RBAC) autour de
 * `applyRecoursTimers`.
 *
 * Articles couverts (voir dossier technique, Partie B.2/B.3 — extraits) :
 *  - Art. 10 : silence de la compagnie destinataire pendant le délai
 *    conventionnel = acceptation tacite du recours.
 *  - Art. 12 : si une opposition est elle-même contestée et que la
 *    compagnie destinataire ne justifie pas sa position dans le délai, la
 *    contestation est réputée fondée — hypothèse retenue ici (le dossier ne
 *    précise pas le circuit exact après l'expiration de ce délai) : le
 *    dossier est escaladé en commission pour tranchage, plutôt que clos
 *    automatiquement dans un sens ou dans l'autre — à valider par le métier.
 *  - Art. 19 : forclusion si le recours reste non réglé au-delà d'un délai
 *    maximal global (garde-fou, indépendant des timers Art. 10/12).
 *
 * ⚠️ HYPOTHÈSE À VALIDER PAR LE MÉTIER (comme pour `EligibilityModule`,
 * voir HANDOFF.md) : le dossier technique ne chiffre pas ici les délais
 * conventionnels exacts (Art. 10/12/19 de ce module — ne pas confondre avec
 * le délai de forclusion de dépôt du recours, déjà couvert côté
 * `EligibilityModule`/`ELIGIBILITY_RECOURS_MAX_MONTHS`). Valeurs par défaut
 * raisonnables retenues, paramétrables par variable d'environnement (voir
 * `recours.service.ts`) :
 *   - silence = acceptation (Art. 10)      : 30 jours à partir de l'envoi.
 *   - justification de la contestation
 *     (Art. 12)                            : 15 jours à partir de la
 *     contestation.
 *   - forclusion globale (Art. 19)         : 180 jours à partir de l'envoi,
 *     tous états non définitifs confondus (garde-fou).
 */

export const RECOURS_STATES = [
  'EN_ATTENTE',
  'ACCEPTE_TACITE',
  'OPPOSITION',
  'CONTESTATION',
  'COMMISSION',
  'REGLE',
  'FORCLOS',
] as const;
export type RecoursState = (typeof RECOURS_STATES)[number];

/** États non définitifs — soumis aux timers conventionnels (Art. 10/12/19). */
const NON_FINAL_STATES: ReadonlySet<RecoursState> = new Set(['EN_ATTENTE', 'OPPOSITION', 'CONTESTATION', 'COMMISSION']);

/** États affichés comme onglets dédiés côté UI (en plus de "tous") — écran 4. */
export const RECOURS_UI_TABS = ['EN_ATTENTE', 'OPPOSITION', 'CONTESTATION', 'COMMISSION', 'FORCLOS'] as const;

export interface RecoursTimerConfig {
  /** Art. 10 — silence = acceptation, en jours depuis `requestSentAt`. */
  silenceDelayDays: number;
  /** Art. 12 — délai de justification d'une contestation, en jours depuis la contestation. */
  contestationJustificationDays: number;
  /** Art. 19 — forclusion globale, en jours depuis `requestSentAt`, tous états non définitifs. */
  forclusionDays: number;
}

export const DEFAULT_RECOURS_TIMER_CONFIG: RecoursTimerConfig = {
  silenceDelayDays: 30,
  contestationJustificationDays: 15,
  forclusionDays: 180,
};

export function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export interface RecoursTimerInput {
  state: RecoursState;
  requestSentAt: Date;
  /** Échéance courante affichée (countdown) — dépend de l'état (silence ou justification). */
  currentDeadlineAt?: Date;
}

export interface RecoursTimerResult {
  state: RecoursState;
  currentDeadlineAt?: Date;
  commissionAt?: Date;
  /** `true` si une transition automatique (non actionnée par un utilisateur) a eu lieu. */
  transitioned: boolean;
  reason?: string;
}

/**
 * Évalue les timers conventionnels pour UN recours à l'instant `now` et
 * renvoie l'état qui en résulte (inchangé si aucune échéance n'est dépassée).
 * Ne mute rien : c'est à l'appelant (`RecoursService`) de persister le
 * résultat si `transitioned === true`.
 */
export function applyRecoursTimers(
  input: RecoursTimerInput,
  now: Date,
  config: RecoursTimerConfig = DEFAULT_RECOURS_TIMER_CONFIG,
): RecoursTimerResult {
  if (!NON_FINAL_STATES.has(input.state)) {
    return { state: input.state, currentDeadlineAt: input.currentDeadlineAt, transitioned: false };
  }

  // Art. 19 — garde-fou de forclusion globale, prioritaire sur tout le reste :
  // un recours qui traîne trop longtemps, quel que soit l'état où il traîne,
  // est forclos.
  const forclusionDeadline = addDaysUtc(input.requestSentAt, config.forclusionDays);
  if (now.getTime() > forclusionDeadline.getTime()) {
    return {
      state: 'FORCLOS',
      currentDeadlineAt: undefined,
      transitioned: true,
      reason: `Forclusion (Art. 19) : non réglé ${config.forclusionDays} jours après l'envoi (${input.requestSentAt.toISOString().slice(0, 10)}).`,
    };
  }

  if (input.state === 'EN_ATTENTE' && input.currentDeadlineAt && now.getTime() > input.currentDeadlineAt.getTime()) {
    return {
      state: 'ACCEPTE_TACITE',
      currentDeadlineAt: undefined,
      transitioned: true,
      reason: `Silence de la compagnie destinataire au-delà du délai conventionnel (Art. 10, ${config.silenceDelayDays} jours) — acceptation tacite.`,
    };
  }

  if (input.state === 'CONTESTATION' && input.currentDeadlineAt && now.getTime() > input.currentDeadlineAt.getTime()) {
    return {
      state: 'COMMISSION',
      currentDeadlineAt: undefined,
      commissionAt: now,
      transitioned: true,
      reason: `Contestation non justifiée dans le délai (Art. 12, ${config.contestationJustificationDays} jours) — escalade en commission pour tranchage.`,
    };
  }

  return { state: input.state, currentDeadlineAt: input.currentDeadlineAt, transitioned: false };
}

/** Échéance à poser quand le recours entre en `EN_ATTENTE` (envoi initial). */
export function computeSilenceDeadline(requestSentAt: Date, config: RecoursTimerConfig = DEFAULT_RECOURS_TIMER_CONFIG): Date {
  return addDaysUtc(requestSentAt, config.silenceDelayDays);
}

/** Échéance à poser quand le recours entre en `CONTESTATION`. */
export function computeContestationDeadline(contestedAt: Date, config: RecoursTimerConfig = DEFAULT_RECOURS_TIMER_CONFIG): Date {
  return addDaysUtc(contestedAt, config.contestationJustificationDays);
}
