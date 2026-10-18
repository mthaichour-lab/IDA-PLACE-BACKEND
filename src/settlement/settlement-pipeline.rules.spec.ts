import { ALGERIA_FIXED_HOLIDAYS, ALGERIA_WEEKEND_DAYS } from '../adherents/referential-reference-data';
import { WorkingCalendar } from '../common/business-days';
import {
  buildPipeline,
  canCompleteStep,
  computeFixedDueDates,
  computePvReglementDueDate,
  monthFollowingQuarter,
  PipelineCompletion,
  PipelineStep,
} from './settlement-pipeline.rules';

const DZ: WorkingCalendar = { weekendDays: ALGERIA_WEEKEND_DAYS, fixedHolidays: ALGERIA_FIXED_HOLIDAYS };
const done = (completedAt: string): PipelineCompletion => ({ completedAt, completedBy: 'operateur' });

describe('Avancement du lot trimestriel — règles pures (Diagramme 2, Art. 16-18)', () => {
  it('M est le mois qui suit la fin du trimestre (Q4 -> janvier suivant)', () => {
    expect(monthFollowingQuarter({ year: 2026, quarter: 1 })).toEqual({ year: 2026, month: 4 });
    expect(monthFollowingQuarter({ year: 2026, quarter: 3 })).toEqual({ year: 2026, month: 10 });
    expect(monthFollowingQuarter({ year: 2026, quarter: 4 })).toEqual({ year: 2027, month: 1 });
  });

  it('échéances 2026-Q3 : 5e jour ouvré d’octobre, 10 octobre, fin octobre', () => {
    expect(computeFixedDueDates({ year: 2026, quarter: 3 }, DZ)).toEqual({
      SAISIE: '2026-10-07',
      SYNTHESE_ANNEXE_7: '2026-10-10',
      TRANSMISSION_ANNEXE_8: '2026-10-31',
      SYNTHESE_GLOBALE_REUNION: '2026-10-31',
    });
  });

  it('échéances 2026-Q4 : M = janvier 2027 (1er janvier férié et vendredi)', () => {
    const due = computeFixedDueDates({ year: 2026, quarter: 4 }, DZ);
    expect(due.SAISIE).toBe('2027-01-07');
    expect(due.SYNTHESE_GLOBALE_REUNION).toBe('2027-01-31');
  });

  it('un férié supplémentaire repousse l’échéance de saisie', () => {
    expect(computeFixedDueDates({ year: 2026, quarter: 3 }, DZ, ['2026-10-05']).SAISIE).toBe('2026-10-08');
  });

  it('PV et règlement : réalisation de l’étape 4 + 8 jours, sinon échéance de l’étape 4 + 8 jours', () => {
    expect(computePvReglementDueDate('2026-10-31')).toBe('2026-11-08');
    expect(computePvReglementDueDate('2026-10-31', '2026-10-20T15:00:00.000Z')).toBe('2026-10-28');
  });

  it('sans réalisation : étape 1 EN_COURS, les autres A_VENIR, aucun retard avant échéance', () => {
    const steps = buildPipeline({ year: 2026, quarter: 3 }, {}, new Date('2026-10-01T09:00:00Z'), DZ);
    expect(steps.map((s) => s.status)).toEqual(['EN_COURS', 'A_VENIR', 'A_VENIR', 'A_VENIR', 'A_VENIR']);
    expect(steps.every((s) => !s.overdue)).toBe(true);
    expect(steps[0]).toMatchObject({ step: 'SAISIE', article: 'Art. 16', dueDate: '2026-10-07' });
    expect(steps[4].dueDate).toBe('2026-11-08');
  });

  it('retard : non réalisée et aujourd’hui strictement après l’échéance', () => {
    const onDue = buildPipeline({ year: 2026, quarter: 3 }, {}, new Date('2026-10-07T22:00:00Z'), DZ);
    expect(onDue[0].overdue).toBe(false);
    const after = buildPipeline({ year: 2026, quarter: 3 }, {}, new Date('2026-10-11T08:00:00Z'), DZ);
    expect(after[0].overdue).toBe(true);
    expect(after[1].overdue).toBe(true);
    expect(after[2].overdue).toBe(false);
  });

  it('étapes faites : DONE, sans retard ; la première non faite passe EN_COURS', () => {
    const completions = { SAISIE: done('2026-10-06T10:00:00Z'), SYNTHESE_ANNEXE_7: done('2026-10-12T10:00:00Z') };
    const steps = buildPipeline({ year: 2026, quarter: 3 }, completions, new Date('2026-10-20T10:00:00Z'), DZ);
    expect(steps.map((s) => s.status)).toEqual(['DONE', 'DONE', 'EN_COURS', 'A_VENIR', 'A_VENIR']);
    expect(steps[1]).toMatchObject({ overdue: false, completedAt: '2026-10-12T10:00:00Z', completedBy: 'operateur' });
  });

  it('l’étape 5 suit la réalisation de l’étape 4 pour son échéance', () => {
    const completions: Partial<Record<PipelineStep, PipelineCompletion>> = {
      SAISIE: done('2026-10-06T10:00:00Z'),
      SYNTHESE_ANNEXE_7: done('2026-10-08T10:00:00Z'),
      TRANSMISSION_ANNEXE_8: done('2026-10-15T10:00:00Z'),
      SYNTHESE_GLOBALE_REUNION: done('2026-10-20T10:00:00Z'),
    };
    const steps = buildPipeline({ year: 2026, quarter: 3 }, completions, new Date('2026-10-29T10:00:00Z'), DZ);
    expect(steps[4]).toMatchObject({ status: 'EN_COURS', dueDate: '2026-10-28', overdue: true });
  });

  it('canCompleteStep : ordre imposé, une seule fois, étape 5 jamais manuelle', () => {
    expect(canCompleteStep('SAISIE', {})).toEqual({ ok: true });
    expect(canCompleteStep('SYNTHESE_ANNEXE_7', {})).toEqual({ ok: false, reason: 'PREVIOUS_PENDING', previous: 'SAISIE' });
    expect(canCompleteStep('SAISIE', { SAISIE: true })).toEqual({ ok: false, reason: 'ALREADY_DONE' });
    expect(canCompleteStep('SYNTHESE_ANNEXE_7', { SAISIE: true })).toEqual({ ok: true });
    expect(canCompleteStep('PV_REGLEMENT', { SAISIE: true, SYNTHESE_ANNEXE_7: true, TRANSMISSION_ANNEXE_8: true, SYNTHESE_GLOBALE_REUNION: true })).toEqual({
      ok: false,
      reason: 'NOT_MANUAL',
    });
  });
});
