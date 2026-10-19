/**
 * Avancement du lot trimestriel (écran 6) — Diagramme 2 de la convention IDA
 * (Art. 16-18). Fonctions PURES : `now` et le calendrier ouvré sont passés
 * en paramètres.
 */
import { nthBusinessDayOfMonth, WorkingCalendar } from '../common/business-days';
import { PeriodQuarter } from './settlement.rules';

export const PIPELINE_STEPS = ['SAISIE', 'SYNTHESE_ANNEXE_7', 'TRANSMISSION_ANNEXE_8', 'SYNTHESE_GLOBALE_REUNION', 'PV_REGLEMENT'] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/** Étapes réalisées manuellement ; `PV_REGLEMENT` découle de la clôture trimestrielle. */
export const MANUAL_PIPELINE_STEPS: readonly PipelineStep[] = ['SAISIE', 'SYNTHESE_ANNEXE_7', 'TRANSMISSION_ANNEXE_8', 'SYNTHESE_GLOBALE_REUNION'];

export const PIPELINE_STEP_INFO: Record<PipelineStep, { label: string; article: string }> = {
  SAISIE: { label: 'Saisie et validation des recours sur la plateforme', article: 'Art. 16' },
  SYNTHESE_ANNEXE_7: { label: 'Synthèse mensuelle automatisée (Annexe n°7)', article: 'Art. 16' },
  TRANSMISSION_ANNEXE_8: {
    label: 'Insertion des informations de règlement (Annexe n°8) et transmission aux parties tierces, copie à la Commission',
    article: 'Art. 16-17',
  },
  SYNTHESE_GLOBALE_REUNION: { label: "Synthèse globale trimestrielle et réunion au siège de l'UAR", article: 'Art. 17-18' },
  PV_REGLEMENT: { label: 'Signature du PV trimestriel (Annexe n°9) et règlement sous 8 jours', article: 'Art. 18' },
};

export type PipelineStepStatus = 'DONE' | 'EN_COURS' | 'A_VENIR';

export interface PipelineCompletion {
  completedAt: string;
  completedBy?: string;
  note?: string;
}

export interface PipelineStepView {
  step: PipelineStep;
  label: string;
  article: string;
  status: PipelineStepStatus;
  dueDate: string;
  overdue: boolean;
  completedAt?: string;
  completedBy?: string;
  note?: string;
}

const SETTLEMENT_DAYS_AFTER_MEETING = 8;

function isoUtc(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function addCalendarDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Mois M qui suit la fin du trimestre (Q4 -> janvier de l'année suivante). */
export function monthFollowingQuarter(period: PeriodQuarter): { year: number; month: number } {
  return period.quarter === 4 ? { year: period.year + 1, month: 1 } : { year: period.year, month: period.quarter * 3 + 1 };
}

/** Échéances des étapes 1 à 4 (l'échéance de l'étape 5 dépend de la réalisation de l'étape 4). */
export function computeFixedDueDates(
  period: PeriodQuarter,
  calendar: WorkingCalendar,
  extraHolidays: readonly string[] = [],
): Record<Exclude<PipelineStep, 'PV_REGLEMENT'>, string> {
  const m = monthFollowingQuarter(period);
  const lastDayOfM = isoUtc(m.year, m.month, 0);
  return {
    SAISIE: nthBusinessDayOfMonth(m.year, m.month, 5, calendar, extraHolidays),
    SYNTHESE_ANNEXE_7: isoUtc(m.year, m.month - 1, 10),
    // Le Diagramme 2 dit « à la clôture du mois » : dernier jour du mois M
    // (décision PO 2026-10-19 — la fin du trimestre précéderait les étapes 1 et 2).
    TRANSMISSION_ANNEXE_8: lastDayOfM,
    // « au plus tard fin du mois suivant le trimestre ».
    SYNTHESE_GLOBALE_REUNION: lastDayOfM,
  };
}

/** Art. 18 : règlement sous 8 jours calendaires après la réunion/signature du PV. */
export function computePvReglementDueDate(meetingDueDate: string, meetingCompletedAt?: string): string {
  return addCalendarDays(meetingCompletedAt ?? meetingDueDate, SETTLEMENT_DAYS_AFTER_MEETING);
}

export function buildPipeline(
  period: PeriodQuarter,
  completions: Partial<Record<PipelineStep, PipelineCompletion>>,
  now: Date,
  calendar: WorkingCalendar,
  extraHolidays: readonly string[] = [],
): PipelineStepView[] {
  const fixed = computeFixedDueDates(period, calendar, extraHolidays);
  const dueDates: Record<PipelineStep, string> = {
    ...fixed,
    PV_REGLEMENT: computePvReglementDueDate(fixed.SYNTHESE_GLOBALE_REUNION, completions.SYNTHESE_GLOBALE_REUNION?.completedAt),
  };
  const today = now.toISOString().slice(0, 10);
  const firstPending = PIPELINE_STEPS.find((s) => !completions[s]);

  return PIPELINE_STEPS.map((step) => {
    const done = completions[step];
    const status: PipelineStepStatus = done ? 'DONE' : step === firstPending ? 'EN_COURS' : 'A_VENIR';
    return {
      step,
      ...PIPELINE_STEP_INFO[step],
      status,
      dueDate: dueDates[step],
      overdue: !done && today > dueDates[step],
      completedAt: done?.completedAt,
      completedBy: done?.completedBy,
      note: done?.note,
    };
  });
}

export type CompletionCheck = { ok: true } | { ok: false; reason: 'NOT_MANUAL' | 'ALREADY_DONE' | 'PREVIOUS_PENDING'; previous?: PipelineStep };

/** Les étapes 1 à 4 se réalisent dans l'ordre, une seule fois chacune. */
export function canCompleteStep(step: PipelineStep, completions: Partial<Record<PipelineStep, unknown>>): CompletionCheck {
  if (!MANUAL_PIPELINE_STEPS.includes(step)) return { ok: false, reason: 'NOT_MANUAL' };
  if (completions[step]) return { ok: false, reason: 'ALREADY_DONE' };
  const idx = PIPELINE_STEPS.indexOf(step);
  if (idx > 0 && !completions[PIPELINE_STEPS[idx - 1]]) return { ok: false, reason: 'PREVIOUS_PENDING', previous: PIPELINE_STEPS[idx - 1] };
  return { ok: true };
}
