import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { AdherentsService } from '../adherents/adherents.service';
import { CLOCK, Clock, systemClock } from '../common/clock';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { LedgerService } from '../ledger/ledger.service';
import { assertPlaceUser, isPlaceUser } from '../recours/place-role';
import { isUniqueViolation, withStrictFallback } from '../recours/strict-persistence';
import { QuarterlyPipelineDto } from './dto/settlement-pipeline.dto';
import { SettlementPipelineStep } from './entities/settlement-pipeline-step.entity';
import { buildPipeline, canCompleteStep, MANUAL_PIPELINE_STEPS, monthFollowingQuarter, PIPELINE_STEPS, PipelineCompletion, PipelineStep } from './settlement-pipeline.rules';
import { parsePeriodQuarter, PeriodQuarter } from './settlement.rules';
import { SettlementService } from './settlement.service';

type StepRecord = PipelineCompletion & { period: string; step: PipelineStep; completedBy: string };

/**
 * Avancement du lot trimestriel (écran 6, Diagramme 2) : étapes 1 à 4
 * réalisées à la main dans l'ordre, étape 5 dérivée de la clôture
 * trimestrielle existante (`POST /settlement/quarter/:q/close`, inchangée).
 * Le calendrier ouvré vient d'`AdherentsService` : `getCalendar()` (week-end,
 * fériés fixes) + `extraHolidays()` (fériés mobiles saisis, prévisionnels
 * compris), relus à chaque lecture.
 */
@Injectable()
export class SettlementPipelineService {
  private readonly memory: StepRecord[] = [];
  private readonly now: Clock;

  constructor(
    @InjectRepository(SettlementPipelineStep) private readonly repo: EntityRepository<SettlementPipelineStep>,
    private readonly settlement: SettlementService,
    private readonly adherents: AdherentsService,
    @Optional() @Inject(CLOCK) clock?: Clock,
    @Optional() private readonly ledger?: LedgerService,
  ) {
    this.now = clock ?? systemClock;
  }

  private parseQuarterOrThrow(q: string): PeriodQuarter {
    try {
      return parsePeriodQuarter(q);
    } catch (err) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: (err as Error).message });
    }
  }

  private async completionsFor(q: string): Promise<Partial<Record<PipelineStep, PipelineCompletion>>> {
    const [rows, closures] = await Promise.all([
      withDegradedFallback(
        'SettlementPipelineService.completionsFor',
        async () =>
          (await this.repo.find({ period: q })).map((r) => ({
            period: r.period,
            step: r.step as PipelineStep,
            completedAt: r.completedAt.toISOString(),
            completedBy: r.completedBy,
            note: r.note,
          })),
        () => this.memory.filter((r) => r.period === q),
      ),
      this.settlement.quarterlyClosures(),
    ]);
    const completions: Partial<Record<PipelineStep, PipelineCompletion>> = {};
    for (const r of rows) completions[r.step] = { completedAt: r.completedAt, completedBy: r.completedBy, note: r.note };
    const closure = closures.find((c) => c.period === q);
    if (closure) completions.PV_REGLEMENT = { completedAt: closure.closedAt, completedBy: closure.closedBy };
    return completions;
  }

  /** SEC-26 : un rôle compagnie lit l'avancement, jamais l'auteur (`completedBy`) ni la note libre d'une étape. */
  async pipeline(q: string, user?: AuthenticatedUser): Promise<QuarterlyPipelineDto> {
    const period = this.parseQuarterOrThrow(q);
    const completions = await this.completionsFor(q);
    const calendar = this.adherents.getCalendar();
    const m = monthFollowingQuarter(period);
    const monthStart = `${m.year}-${String(m.month).padStart(2, '0')}-01`;
    const monthEnd = new Date(Date.UTC(m.year, m.month, 0)).toISOString().slice(0, 10);
    const extraHolidays = await this.adherents.extraHolidays(monthStart, monthEnd);
    const steps = buildPipeline(period, completions, this.now(), calendar, extraHolidays);
    const full = !user || isPlaceUser(user);
    return { quarter: q, steps: full ? steps : steps.map(({ completedBy: _by, note: _note, ...rest }) => rest) };
  }

  /**
   * Art. 18 : le PV trimestriel n'est signé qu'après la synthèse globale et
   * la réunion UAR — la clôture (étape 5) exige donc les étapes 1 à 4.
   */
  async assertReadyToClose(q: string): Promise<void> {
    this.parseQuarterOrThrow(q);
    const completions = await this.completionsFor(q);
    const missing = MANUAL_PIPELINE_STEPS.find((s) => !completions[s]);
    if (missing) {
      throw new ConflictException({
        code: 'PIPELINE_INCOMPLET',
        message: `Clôture impossible : l'étape ${missing} de l'avancement du lot ${q} n'est pas réalisée (les étapes 1 à 4 précèdent la signature du PV, Art. 18).`,
      });
    }
  }

  /** SEC-25 : rôle place uniquement, même avec le privilège `closeQuarter` obtenu par dérogation ; étape scellée au journal. */
  async completeStep(q: string, step: string, user: AuthenticatedUser, note?: string): Promise<QuarterlyPipelineDto> {
    assertPlaceUser(user);
    const completedBy = user.name;
    this.parseQuarterOrThrow(q);
    if (!(PIPELINE_STEPS as readonly string[]).includes(step)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: `Étape inconnue : "${step}" (attendu ${PIPELINE_STEPS.join(', ')}).` });
    }
    const target = step as PipelineStep;
    const check = canCompleteStep(target, await this.completionsFor(q));
    if (!check.ok) {
      const message =
        check.reason === 'NOT_MANUAL'
          ? `L'étape ${target} est réalisée par la clôture trimestrielle (POST /settlement/quarter/${q}/close).`
          : check.reason === 'ALREADY_DONE'
            ? `L'étape ${target} est déjà réalisée pour ${q}.`
            : `L'étape ${check.previous} doit être réalisée avant ${target}.`;
      throw new ConflictException({ code: 'INVALID_TRANSITION', message });
    }

    const record: StepRecord = { period: q, step: target, completedAt: this.now().toISOString(), completedBy, note: note?.trim() || undefined };
    const duplicate = () => new ConflictException({ code: 'INVALID_TRANSITION', message: `L'étape ${target} est déjà réalisée pour ${q}.` });
    const summary = JSON.stringify({ period: q, step: target });
    await withStrictFallback(
      'SettlementPipelineService.completeStep',
      async () => {
        try {
          await this.repo.getEntityManager().fork({ clear: true }).transactional(async (tem) => {
            tem.create(SettlementPipelineStep, {
              period: record.period,
              step: record.step,
              completedAt: new Date(record.completedAt),
              completedBy: record.completedBy,
              note: record.note,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any);
            await tem.flush();
            if (this.ledger) await this.ledger.append('ETAPE_LOT_TRIMESTRIEL', `${q}/${target}`, user.id, summary);
          });
        } catch (err) {
          // Requête concurrente sur la même étape : contrainte UNIQUE(period, step) → 409.
          throw isUniqueViolation(err) || err instanceof UniqueConstraintViolationException ? duplicate() : err;
        }
      },
      async () => {
        if (this.memory.some((r) => r.period === q && r.step === target)) throw duplicate();
        this.memory.push(record);
        if (this.ledger) await this.ledger.append('ETAPE_LOT_TRIMESTRIEL', `${q}/${target}`, user.id, summary);
      },
    );
    return this.pipeline(q, user);
  }
}
