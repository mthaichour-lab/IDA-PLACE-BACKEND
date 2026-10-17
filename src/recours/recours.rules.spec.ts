import {
  addDaysUtc,
  applyRecoursTimers,
  computeContestationDeadline,
  computeSilenceDeadline,
  DEFAULT_RECOURS_TIMER_CONFIG,
  RecoursTimerInput,
} from './recours.rules';

const CONFIG = DEFAULT_RECOURS_TIMER_CONFIG; // 30 / 15 / 180 jours

function at(daysFromEpoch: number): Date {
  return new Date(Date.UTC(2026, 0, 1 + daysFromEpoch));
}

describe('applyRecoursTimers (B.2/B.3, écran 4)', () => {
  it("ne transitionne pas un recours EN_ATTENTE avant l'échéance de silence (Art. 10)", () => {
    const sentAt = at(0);
    const input: RecoursTimerInput = { state: 'EN_ATTENTE', requestSentAt: sentAt, currentDeadlineAt: computeSilenceDeadline(sentAt, CONFIG) };
    const result = applyRecoursTimers(input, at(29), CONFIG);
    expect(result.transitioned).toBe(false);
    expect(result.state).toBe('EN_ATTENTE');
  });

  it('bascule en ACCEPTE_TACITE exactement au-delà du délai de silence (Art. 10)', () => {
    const sentAt = at(0);
    const input: RecoursTimerInput = { state: 'EN_ATTENTE', requestSentAt: sentAt, currentDeadlineAt: computeSilenceDeadline(sentAt, CONFIG) };
    const result = applyRecoursTimers(input, at(31), CONFIG);
    expect(result.transitioned).toBe(true);
    expect(result.state).toBe('ACCEPTE_TACITE');
    expect(result.currentDeadlineAt).toBeUndefined();
  });

  it("ne transitionne pas un recours en OPPOSITION (pas de timer propre, hors forclusion globale)", () => {
    const sentAt = at(0);
    const input: RecoursTimerInput = { state: 'OPPOSITION', requestSentAt: sentAt };
    const result = applyRecoursTimers(input, at(60), CONFIG);
    expect(result.transitioned).toBe(false);
    expect(result.state).toBe('OPPOSITION');
  });

  it('escalade une CONTESTATION non justifiée en COMMISSION (Art. 12)', () => {
    const sentAt = at(0);
    const contestedAt = at(40);
    const input: RecoursTimerInput = { state: 'CONTESTATION', requestSentAt: sentAt, currentDeadlineAt: computeContestationDeadline(contestedAt, CONFIG) };
    const result = applyRecoursTimers(input, at(40 + 16), CONFIG);
    expect(result.transitioned).toBe(true);
    expect(result.state).toBe('COMMISSION');
    expect(result.commissionAt).toBeDefined();
  });

  it('ne transitionne pas une CONTESTATION encore dans son délai de justification (Art. 12)', () => {
    const sentAt = at(0);
    const contestedAt = at(40);
    const input: RecoursTimerInput = { state: 'CONTESTATION', requestSentAt: sentAt, currentDeadlineAt: computeContestationDeadline(contestedAt, CONFIG) };
    const result = applyRecoursTimers(input, at(40 + 10), CONFIG);
    expect(result.transitioned).toBe(false);
  });

  it('force la forclusion (Art. 19) au-delà du délai global, même en COMMISSION', () => {
    const sentAt = at(0);
    const input: RecoursTimerInput = { state: 'COMMISSION', requestSentAt: sentAt };
    const result = applyRecoursTimers(input, at(181), CONFIG);
    expect(result.transitioned).toBe(true);
    expect(result.state).toBe('FORCLOS');
  });

  it('la forclusion globale (Art. 19) est prioritaire sur le silence (Art. 10) si les deux sont dépassés', () => {
    const sentAt = at(0);
    const input: RecoursTimerInput = { state: 'EN_ATTENTE', requestSentAt: sentAt, currentDeadlineAt: computeSilenceDeadline(sentAt, CONFIG) };
    const result = applyRecoursTimers(input, at(200), CONFIG);
    expect(result.state).toBe('FORCLOS');
  });

  it('ne transitionne jamais un état définitif (REGLE)', () => {
    const sentAt = at(0);
    const input: RecoursTimerInput = { state: 'REGLE', requestSentAt: sentAt };
    const result = applyRecoursTimers(input, at(400), CONFIG);
    expect(result.transitioned).toBe(false);
    expect(result.state).toBe('REGLE');
  });

  it('ne transitionne jamais un état définitif (FORCLOS)', () => {
    const sentAt = at(0);
    const input: RecoursTimerInput = { state: 'FORCLOS', requestSentAt: sentAt };
    const result = applyRecoursTimers(input, at(400), CONFIG);
    expect(result.transitioned).toBe(false);
  });

  it('addDaysUtc ajoute bien des jours calendaires UTC', () => {
    const d = addDaysUtc(new Date(Date.UTC(2026, 0, 1)), 10);
    expect(d.toISOString().slice(0, 10)).toBe('2026-01-11');
  });
});
