import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AdherentsService } from '../adherents/adherents.service';
import { ALGERIA_FIXED_HOLIDAYS, ALGERIA_WEEKEND_DAYS } from '../adherents/referential-reference-data';
import { CLOCK } from '../common/clock';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { Recours } from '../recours/entities/recours.entity';
import { RecoursService } from '../recours/recours.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import { SettlementClosure } from './entities/settlement-closure.entity';
import { SettlementPipelineStep } from './entities/settlement-pipeline-step.entity';
import { SettlementPipelineService } from './settlement-pipeline.service';
import { SettlementService } from './settlement.service';
import { simulatedDatabaseOutage } from '../common/database/db-errors';

const OP: AuthenticatedUser = { id: 'id-op', name: 'op', email: 'op@test.local', role: 'OPERATEUR_PLACE', privileges: ['closeQuarter'] };
const OPERATEUR: AuthenticatedUser = { ...OP, id: 'id-operateur', name: 'operateur' };
const CORRESPONDANT: AuthenticatedUser = { id: 'c', name: 'corr', email: 'c@test.local', role: 'CORRESPONDANT_IDA', companyId: 'CAAT', privileges: ['closeQuarter'] };

/** Repli mémoire forcé — voir settlement.service.spec.ts. */
function throwingRepo() {
  return {
    create: jest.fn((data: unknown) => data),
    find: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    findOne: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    findAll: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    getEntityManager: jest.fn(() => {
      const em: Record<string, jest.Mock> = {
        persistAndFlush: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
        flush: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
        find: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
        transactional: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
      };
      em.fork = jest.fn(() => em);
      return em;
    }),
  };
}

async function build(stepRepo: unknown, mobileHolidays: string[] = []) {
  const extraHolidays = jest.fn(async () => mobileHolidays);
  const moduleRef = await Test.createTestingModule({
    providers: [
      SettlementPipelineService,
      SettlementService,
      RecoursService,
      { provide: getRepositoryToken(SettlementPipelineStep), useValue: stepRepo },
      { provide: getRepositoryToken(SettlementClosure), useFactory: throwingRepo },
      { provide: getRepositoryToken(Recours), useFactory: throwingRepo },
      { provide: ConfigService, useValue: { get: () => undefined } },
      { provide: RealtimeGateway, useValue: { emitEvent: jest.fn() } },
      {
        provide: AdherentsService,
        useValue: { getCalendar: () => ({ weekendDays: ALGERIA_WEEKEND_DAYS, fixedHolidays: ALGERIA_FIXED_HOLIDAYS }), extraHolidays },
      },
      { provide: CLOCK, useValue: () => new Date('2026-10-12T09:00:00Z') },
    ],
  }).compile();
  return { pipeline: moduleRef.get(SettlementPipelineService), settlement: moduleRef.get(SettlementService), extraHolidays };
}

describe('SettlementPipelineService (mode dégradé — avancement du lot trimestriel)', () => {
  let pipeline: SettlementPipelineService;
  let settlement: SettlementService;

  beforeEach(async () => {
    ({ pipeline, settlement } = await build(throwingRepo()));
  });

  it('expose les 5 étapes avec échéances, statuts et retards', async () => {
    const res = await pipeline.pipeline('2026-Q3');
    expect(res.quarter).toBe('2026-Q3');
    expect(res.steps.map((s) => [s.step, s.status, s.dueDate, s.overdue])).toEqual([
      ['SAISIE', 'EN_COURS', '2026-10-07', true],
      ['SYNTHESE_ANNEXE_7', 'A_VENIR', '2026-10-10', true],
      ['TRANSMISSION_ANNEXE_8', 'A_VENIR', '2026-10-31', false],
      ['SYNTHESE_GLOBALE_REUNION', 'A_VENIR', '2026-10-31', false],
      ['PV_REGLEMENT', 'A_VENIR', '2026-11-08', false],
    ]);
  });

  it('un férié mobile saisi dans le mois M décale le 5e jour ouvré (étape SAISIE)', async () => {
    const built = await build(throwingRepo(), ['2026-10-05']);
    const res = await built.pipeline.pipeline('2026-Q3');
    expect(built.extraHolidays).toHaveBeenCalledWith('2026-10-01', '2026-10-31');
    expect(res.steps[0]).toMatchObject({ step: 'SAISIE', dueDate: '2026-10-08' });
  });

  it('400 sur un trimestre ou une étape invalides', async () => {
    await expect(pipeline.pipeline('2026-Q5')).rejects.toMatchObject({ status: 400 });
    await expect(pipeline.completeStep('2026-Q3', 'INCONNUE', OP)).rejects.toMatchObject({ status: 400 });
  });

  it('étapes réalisées dans l’ordre : 409 si l’étape précédente n’est pas faite ou si déjà faite', async () => {
    await expect(pipeline.completeStep('2026-Q3', 'SYNTHESE_ANNEXE_7', OP)).rejects.toMatchObject({ status: 409 });
    const after1 = await pipeline.completeStep('2026-Q3', 'SAISIE', OP, 'Saisie validée');
    expect(after1.steps[0]).toMatchObject({ status: 'DONE', overdue: false, completedBy: 'op', note: 'Saisie validée', completedAt: '2026-10-12T09:00:00.000Z' });
    expect(after1.steps[1].status).toBe('EN_COURS');
    await expect(pipeline.completeStep('2026-Q3', 'SAISIE', OP)).rejects.toMatchObject({ status: 409 });
    await expect(pipeline.completeStep('2026-Q3', 'SYNTHESE_ANNEXE_7', OP)).resolves.toBeDefined();
  });

  it('l’étape 5 n’est jamais réalisée à la main (409) : elle suit la clôture trimestrielle', async () => {
    await expect(pipeline.completeStep('2026-Q3', 'PV_REGLEMENT', OP)).rejects.toMatchObject({ status: 409 });
    await settlement.closeQuarterly('2026-Q3', OPERATEUR);
    const res = await pipeline.pipeline('2026-Q3');
    expect(res.steps[4]).toMatchObject({ status: 'DONE', completedBy: 'operateur', overdue: false });
    expect(res.steps[0].status).toBe('EN_COURS');
  });

  it('assertReadyToClose : 409 PIPELINE_INCOMPLET tant qu’une étape 1-4 manque, puis passe', async () => {
    await expect(pipeline.assertReadyToClose('2026-Q3')).rejects.toMatchObject({ status: 409, response: { code: 'PIPELINE_INCOMPLET' } });
    for (const step of ['SAISIE', 'SYNTHESE_ANNEXE_7', 'TRANSMISSION_ANNEXE_8']) await pipeline.completeStep('2026-Q3', step, OP);
    await expect(pipeline.assertReadyToClose('2026-Q3')).rejects.toMatchObject({ response: { message: expect.stringContaining('SYNTHESE_GLOBALE_REUNION') } });
    await pipeline.completeStep('2026-Q3', 'SYNTHESE_GLOBALE_REUNION', OP);
    await expect(pipeline.assertReadyToClose('2026-Q3')).resolves.toBeUndefined();
  });

  it('les trimestres sont indépendants', async () => {
    await pipeline.completeStep('2026-Q3', 'SAISIE', OP);
    expect((await pipeline.pipeline('2026-Q2')).steps[0].status).toBe('EN_COURS');
  });

  it('une violation d’unicité en base (requête concurrente) donne un 409, jamais un repli mémoire', async () => {
    const repo = {
      create: jest.fn((data: unknown) => data),
      find: jest.fn().mockResolvedValue([]),
      getEntityManager: jest.fn(() => ({
        fork: () => ({ transactional: jest.fn().mockRejectedValue(new UniqueConstraintViolationException(new Error('duplicate key'))) }),
      })),
    };
    ({ pipeline } = await build(repo));
    await expect(pipeline.completeStep('2026-Q3', 'SAISIE', OP)).rejects.toMatchObject({ status: 409 });
  });

  it('SEC-25 : un utilisateur compagnie ne fait jamais avancer le lot, même avec le privilège closeQuarter (403)', async () => {
    await expect(pipeline.completeStep('2026-Q3', 'SAISIE', CORRESPONDANT)).rejects.toMatchObject({ status: 403 });
  });

  it('SEC-26 : un rôle compagnie lit l’avancement sans l’auteur ni la note des étapes', async () => {
    await pipeline.completeStep('2026-Q3', 'SAISIE', OP, 'Note interne');
    const forCompany = await pipeline.pipeline('2026-Q3', CORRESPONDANT);
    expect(forCompany.steps[0].status).toBe('DONE');
    expect(forCompany.steps[0]).not.toHaveProperty('completedBy');
    expect(forCompany.steps[0]).not.toHaveProperty('note');
    expect((await pipeline.pipeline('2026-Q3', OP)).steps[0]).toMatchObject({ completedBy: 'op', note: 'Note interne' });
  });
});
