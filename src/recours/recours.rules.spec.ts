import {
  applyAutomaticTransitions,
  applyManualTransition,
  buildRecoursJourneySteps,
  computeTimerState,
  DEFAULT_RECOURS_TIMER_CONFIG,
  isActionAllowed,
  RecoursSnapshot,
  RecoursTimerConfig,
} from './recours.rules';

const CONFIG: RecoursTimerConfig = { silenceDays: 30, oppositionDays: 15, forclusionMonths: 6 };

function snapshot(overrides: Partial<RecoursSnapshot> = {}): RecoursSnapshot {
  return {
    state: 'EN_ATTENTE',
    requestSentAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('computeTimerState (countdownBar — Art.10/12/19)', () => {
  it('EN_ATTENTE : timer SILENCE_ART10 affiché quand il est plus proche que la forclusion', () => {
    const s = snapshot();
    const now = new Date('2026-01-10T00:00:00.000Z');
    const timer = computeTimerState(s, now, CONFIG);
    expect(timer.timerType).toBe('SILENCE_ART10');
    expect(timer.deadlineAt).toBe(new Date('2026-01-31T00:00:00.000Z').toISOString());
    expect(timer.expired).toBe(false);
  });

  it('EN_ATTENTE : remainingDays décroît correctement jusqu’à échéance', () => {
    const s = snapshot();
    const now = new Date('2026-01-30T00:00:00.000Z'); // 1 jour avant échéance Art.10 (31/01)
    const timer = computeTimerState(s, now, CONFIG);
    expect(timer.timerType).toBe('SILENCE_ART10');
    expect(timer.remainingDays).toBe(1);
  });

  it('timer AUCUN pour un état terminal (REGLE)', () => {
    const s = snapshot({ state: 'REGLE', resolution: { kind: 'ACCEPTATION_EXPRESSE', at: '2026-01-05T00:00:00.000Z' } });
    const timer = computeTimerState(s, new Date('2026-06-01T00:00:00.000Z'), CONFIG);
    expect(timer.timerType).toBe('AUCUN');
    expect(timer.expired).toBe(false);
  });

  it('OPPOSITION en cours : timer OPPOSITION_ART12', () => {
    const s = snapshot({
      state: 'OPPOSITION',
      responseAt: '2026-01-10T00:00:00.000Z',
      opposition: { raisedAt: '2026-01-10T00:00:00.000Z', status: 'EN_COURS', deadlineAt: '2026-01-25T00:00:00.000Z' },
    });
    const timer = computeTimerState(s, new Date('2026-01-20T00:00:00.000Z'), CONFIG);
    expect(timer.timerType).toBe('OPPOSITION_ART12');
    expect(timer.deadlineAt).toBe(new Date('2026-01-25T00:00:00.000Z').toISOString());
  });

  it('CONTESTATION : pas de sous-délai propre, seule la forclusion Art.19 s’applique', () => {
    const s = snapshot({ state: 'CONTESTATION', contestation: { raisedAt: '2026-02-01T00:00:00.000Z', status: 'EN_COURS' } });
    const timer = computeTimerState(s, new Date('2026-02-10T00:00:00.000Z'), CONFIG);
    expect(timer.timerType).toBe('FORCLUSION_ART19');
    // forclusion = requestSentAt (01/01) + 6 mois = 01/07
    expect(timer.deadlineAt).toBe(new Date('2026-07-01T00:00:00.000Z').toISOString());
  });

  it('la forclusion Art.19 prime quand elle devient plus proche que le silence Art.10 (cas limite d’égalité)', () => {
    // silenceDays très long pour forcer la forclusion à être la plus proche.
    const config: RecoursTimerConfig = { silenceDays: 365, oppositionDays: 15, forclusionMonths: 6 };
    const s = snapshot();
    const timer = computeTimerState(s, new Date('2026-01-10T00:00:00.000Z'), config);
    expect(timer.timerType).toBe('FORCLUSION_ART19');
  });
});

describe('applyAutomaticTransitions — Art.10 (silence = acceptation tacite)', () => {
  it('ne change rien tant que le délai de silence n’est pas dépassé (cas limite : exactement à l’échéance)', () => {
    const s = snapshot();
    const now = new Date('2026-01-31T00:00:00.000Z'); // == échéance exacte, pas encore "après"
    const { changed } = applyAutomaticTransitions(s, now, CONFIG);
    expect(changed).toBe(false);
  });

  it('bascule en REGLE (acceptation tacite) 1ms après l’échéance Art.10', () => {
    const s = snapshot();
    const now = new Date(new Date('2026-01-31T00:00:00.000Z').getTime() + 1);
    const { changed, snapshot: next } = applyAutomaticTransitions(s, now, CONFIG);
    expect(changed).toBe(true);
    expect(next.state).toBe('REGLE');
    expect(next.resolution?.kind).toBe('ACCEPTATION_TACITE_ART10');
    expect(next.responseAt).toBe(now.toISOString());
    expect(next.settledAt).toBe(now.toISOString()); // B.3 : Recours.settledAt doit être posé dès que state=REGLE
  });

  it('ne touche jamais un état terminal (REJETE)', () => {
    const s = snapshot({ state: 'REJETE', resolution: { kind: 'OPPOSITION_FONDEE_ART12', at: '2026-01-05T00:00:00.000Z' } });
    const { changed, snapshot: next } = applyAutomaticTransitions(s, new Date('2027-01-01T00:00:00.000Z'), CONFIG);
    expect(changed).toBe(false);
    expect(next).toBe(s);
  });
});

describe('applyAutomaticTransitions — Art.12 (opposition non traitée = réputée fondée)', () => {
  it('ne change rien tant que le délai de traitement de l’opposition n’est pas dépassé', () => {
    const s = snapshot({
      state: 'OPPOSITION',
      opposition: { raisedAt: '2026-01-10T00:00:00.000Z', status: 'EN_COURS', deadlineAt: '2026-01-25T00:00:00.000Z' },
    });
    const { changed } = applyAutomaticTransitions(s, new Date('2026-01-25T00:00:00.000Z'), CONFIG);
    expect(changed).toBe(false);
  });

  it('bascule en REJETE (opposition réputée fondée) juste après le délai Art.12', () => {
    const s = snapshot({
      state: 'OPPOSITION',
      opposition: { raisedAt: '2026-01-10T00:00:00.000Z', status: 'EN_COURS', deadlineAt: '2026-01-25T00:00:00.000Z' },
    });
    const now = new Date(new Date('2026-01-25T00:00:00.000Z').getTime() + 1);
    const { changed, snapshot: next } = applyAutomaticTransitions(s, now, CONFIG);
    expect(changed).toBe(true);
    expect(next.state).toBe('REJETE');
    expect(next.opposition?.status).toBe('FONDEE_TACITE');
    expect(next.resolution?.kind).toBe('OPPOSITION_FONDEE_ART12');
  });

  it('une opposition déjà tranchée (REJETEE) n’est plus affectée par le délai Art.12', () => {
    const s = snapshot({
      state: 'OPPOSITION',
      opposition: { raisedAt: '2026-01-10T00:00:00.000Z', status: 'REJETEE', deadlineAt: '2026-01-25T00:00:00.000Z' },
    });
    const { changed } = applyAutomaticTransitions(s, new Date('2026-02-01T00:00:00.000Z'), CONFIG);
    expect(changed).toBe(false);
  });
});

describe('applyAutomaticTransitions — Art.19 (forclusion globale, priorité absolue)', () => {
  it('ne change rien exactement à l’échéance de 6 mois (cas limite — état CONTESTATION, sans sous-délai propre)', () => {
    // CONTESTATION n'a pas de sous-délai propre (seule la forclusion Art.19
    // s'applique) : isole bien le cas limite de la forclusion elle-même,
    // contrairement à EN_ATTENTE dont le silence Art.10 (30 jours par
    // défaut) aurait déjà résolu le recours bien avant les 6 mois.
    const s = snapshot({ state: 'CONTESTATION', contestation: { raisedAt: '2026-01-05T00:00:00.000Z', status: 'EN_COURS' } });
    const { changed } = applyAutomaticTransitions(s, new Date('2026-07-01T00:00:00.000Z'), CONFIG);
    expect(changed).toBe(false);
  });

  it('bascule en FORCLOS 1ms après l’échéance de 6 mois, quel que soit le sous-état', () => {
    const now = new Date(new Date('2026-07-01T00:00:00.000Z').getTime() + 1);
    for (const state of ['EN_ATTENTE', 'OPPOSITION', 'CONTESTATION', 'COMMISSION'] as const) {
      const s = snapshot({ state });
      const { changed, snapshot: next } = applyAutomaticTransitions(s, now, CONFIG);
      expect(changed).toBe(true);
      expect(next.state).toBe('FORCLOS');
      expect(next.resolution?.kind).toBe('FORCLUSION_ART19');
    }
  });

  it('la forclusion prime sur l’acceptation tacite Art.10 si les deux délais sont dépassés simultanément', () => {
    const s = snapshot();
    const now = new Date('2027-01-01T00:00:00.000Z'); // largement après silence ET forclusion
    const { snapshot: next } = applyAutomaticTransitions(s, now, CONFIG);
    expect(next.state).toBe('FORCLOS');
  });
});

describe('isActionAllowed — machine d’état (validation humaine)', () => {
  it('autorise accepter/opposer uniquement depuis EN_ATTENTE', () => {
    expect(isActionAllowed('EN_ATTENTE', 'accepter')).toBe(true);
    expect(isActionAllowed('EN_ATTENTE', 'opposer')).toBe(true);
    expect(isActionAllowed('EN_ATTENTE', 'contester')).toBe(false);
  });

  it('aucune action autorisée sur un état terminal', () => {
    for (const state of ['REGLE', 'REJETE', 'FORCLOS'] as const) {
      for (const action of ['accepter', 'opposer', 'contester', 'transmettre_commission'] as const) {
        expect(isActionAllowed(state, action)).toBe(false);
      }
    }
  });

  it('transmettre_commission uniquement depuis CONTESTATION', () => {
    expect(isActionAllowed('CONTESTATION', 'transmettre_commission')).toBe(true);
    expect(isActionAllowed('OPPOSITION', 'transmettre_commission')).toBe(false);
  });
});

describe('applyManualTransition', () => {
  it('renvoie null si l’action est interdite dans l’état courant (ex: accepter depuis COMMISSION)', () => {
    const s = snapshot({ state: 'COMMISSION', commissionAt: '2026-02-01T00:00:00.000Z' });
    const result = applyManualTransition(s, 'accepter', new Date('2026-02-05T00:00:00.000Z'), CONFIG);
    expect(result).toBeNull();
  });

  it('accepter : EN_ATTENTE -> REGLE (acceptation expresse)', () => {
    const s = snapshot();
    const now = new Date('2026-01-15T00:00:00.000Z');
    const next = applyManualTransition(s, 'accepter', now, CONFIG);
    expect(next?.state).toBe('REGLE');
    expect(next?.resolution?.kind).toBe('ACCEPTATION_EXPRESSE');
    expect(next?.responseAt).toBe(now.toISOString());
    expect(next?.settledAt).toBe(now.toISOString()); // B.3 : Recours.settledAt doit être posé dès que state=REGLE
  });

  it('opposer : EN_ATTENTE -> OPPOSITION, pose l’échéance Art.12', () => {
    const s = snapshot();
    const now = new Date('2026-01-15T00:00:00.000Z');
    const next = applyManualTransition(s, 'opposer', now, CONFIG, { reason: 'Montant contesté' });
    expect(next?.state).toBe('OPPOSITION');
    expect(next?.opposition?.status).toBe('EN_COURS');
    expect(next?.opposition?.reason).toBe('Montant contesté');
    expect(next?.opposition?.deadlineAt).toBe(new Date('2026-01-30T00:00:00.000Z').toISOString());
  });

  it('lever_opposition : OPPOSITION -> REGLE (opposition levée)', () => {
    const s = snapshot({
      state: 'OPPOSITION',
      opposition: { raisedAt: '2026-01-15T00:00:00.000Z', status: 'EN_COURS', deadlineAt: '2026-01-30T00:00:00.000Z' },
    });
    const now = new Date('2026-01-20T00:00:00.000Z');
    const next = applyManualTransition(s, 'lever_opposition', now, CONFIG);
    expect(next?.state).toBe('REGLE');
    expect(next?.opposition?.status).toBe('REJETEE');
    expect(next?.resolution?.kind).toBe('OPPOSITION_LEVEE');
    expect(next?.settledAt).toBe(now.toISOString()); // B.3 : Recours.settledAt doit être posé dès que state=REGLE
  });

  it('contester puis transmettre_commission : OPPOSITION -> CONTESTATION -> COMMISSION', () => {
    const s = snapshot({
      state: 'OPPOSITION',
      opposition: { raisedAt: '2026-01-15T00:00:00.000Z', status: 'EN_COURS', deadlineAt: '2026-01-30T00:00:00.000Z' },
    });
    const afterContest = applyManualTransition(s, 'contester', new Date('2026-01-18T00:00:00.000Z'), CONFIG, { reason: 'Désaccord' });
    expect(afterContest?.state).toBe('CONTESTATION');

    const afterTransmit = applyManualTransition(afterContest!, 'transmettre_commission', new Date('2026-01-20T00:00:00.000Z'), CONFIG);
    expect(afterTransmit?.state).toBe('COMMISSION');
    expect(afterTransmit?.commissionAt).toBe(new Date('2026-01-20T00:00:00.000Z').toISOString());
    expect(afterTransmit?.contestation?.status).toBe('TRANSMISE_COMMISSION');
  });

  it('cloturer_commission_favorable : COMMISSION -> REGLE', () => {
    const s = snapshot({ state: 'COMMISSION', commissionAt: '2026-02-01T00:00:00.000Z' });
    const now = new Date('2026-02-10T00:00:00.000Z');
    const next = applyManualTransition(s, 'cloturer_commission_favorable', now, CONFIG, { reason: 'Décision favorable' });
    expect(next?.state).toBe('REGLE');
    expect(next?.resolution?.kind).toBe('DECISION_COMMISSION_FAVORABLE');
    expect(next?.settledAt).toBe(now.toISOString()); // B.3 : Recours.settledAt doit être posé dès que state=REGLE
  });

  it('cloturer_commission_defavorable : COMMISSION -> REJETE', () => {
    const s = snapshot({ state: 'COMMISSION', commissionAt: '2026-02-01T00:00:00.000Z' });
    const next = applyManualTransition(s, 'cloturer_commission_defavorable', new Date('2026-02-10T00:00:00.000Z'), CONFIG);
    expect(next?.state).toBe('REJETE');
    expect(next?.resolution?.kind).toBe('DECISION_COMMISSION_DEFAVORABLE');
  });
});

describe('cohérence par défaut (DEFAULT_RECOURS_TIMER_CONFIG)', () => {
  it('silence 30 jours / opposition 15 jours / forclusion 6 mois (hypothèse documentée, paramétrable)', () => {
    expect(DEFAULT_RECOURS_TIMER_CONFIG).toEqual({ silenceDays: 30, oppositionDays: 15, forclusionMonths: 6 });
  });
});

describe('buildRecoursJourneySteps — parcours réel (MonitoringModule, écran 8)', () => {
  it('chemin direct (silence ou acceptation) : une seule étape (annexe2)', () => {
    const steps = buildRecoursJourneySteps(snapshot());
    expect(steps.map((s) => s.key)).toEqual(['annexe2']);
  });

  it('chemin avec opposition levée : annexe2 + annexe3, triées chronologiquement', () => {
    const s = snapshot({
      state: 'OPPOSITION',
      opposition: { raisedAt: '2026-01-05T00:00:00.000Z', status: 'EN_COURS', deadlineAt: '2026-01-20T00:00:00.000Z' },
    });
    const steps = buildRecoursJourneySteps(s);
    expect(steps.map((s) => s.key)).toEqual(['annexe2', 'annexe3']);
  });

  it('chemin complet (opposition → contestation → commission → décision) : 5 étapes réelles, jamais un compte fixe inventé', () => {
    const s = snapshot({
      state: 'REGLE',
      opposition: { raisedAt: '2026-01-05T00:00:00.000Z', status: 'REJETEE', deadlineAt: '2026-01-20T00:00:00.000Z', decidedAt: '2026-01-25T00:00:00.000Z' },
      contestation: { raisedAt: '2026-01-10T00:00:00.000Z', status: 'TRANSMISE_COMMISSION' },
      commissionAt: '2026-01-15T00:00:00.000Z',
      resolution: { kind: 'DECISION_COMMISSION_FAVORABLE', at: '2026-01-25T00:00:00.000Z' },
    });
    const steps = buildRecoursJourneySteps(s);
    expect(steps.map((s) => s.key)).toEqual(['annexe2', 'annexe3', 'annexe4', 'commission', 'resolution']);
  });
});
