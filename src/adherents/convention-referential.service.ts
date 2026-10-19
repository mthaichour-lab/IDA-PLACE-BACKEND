import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import {
  ConfirmMobileHolidayDto,
  CreateMobileHolidayDto,
  CreateOppositionMotifDto,
  UpdateConstatCircumstanceDto,
  UpdateMobileHolidayDto,
  UpdateOppositionMotifDto,
} from './dto/place-referential.dto';
import { ConstatCircumstance } from './entities/constat-circumstance.entity';
import { MobileHoliday } from './entities/mobile-holiday.entity';
import { OppositionMotif } from './entities/opposition-motif.entity';
import {
  CONSTAT_CIRCUMSTANCES_SEED,
  ConstatCircumstanceStatus,
  MOBILE_HOLIDAY_KIND_LABELS,
  MobileHolidayKind,
  MobileHolidayStatus,
  OPPOSITION_MOTIFS_SEED,
  OppositionMotifStatus,
  SEED_AUTHOR,
} from './place-referential.data';
import { algeriaFixedHolidays } from './referential-reference-data';
import { assertFourEyes, assertIsoDate } from './referential-rules';

const MAX_CALENDAR_SPAN_YEARS = 10;

export interface MobileHolidayView {
  id: string;
  date: string;
  kind: MobileHolidayKind;
  label: string;
  hijriYear?: number;
  status: MobileHolidayStatus;
  sourceRef?: string;
  createdBy: string;
  createdAt: string;
  confirmedBy?: string;
  confirmedAt?: string;
}

export interface CalendarHolidayView {
  date: string;
  label: string;
  type: 'FIXE' | 'MOBILE';
  kind?: MobileHolidayKind;
  status: 'LEGAL' | MobileHolidayStatus;
  sourceRef?: string;
}

export interface ConstatCircumstanceView {
  number: number;
  labelFr: string;
  labelAr?: string;
  status: ConstatCircumstanceStatus;
  createdBy: string;
  updatedBy?: string;
  validatedBy?: string;
  validatedAt?: string;
}

export interface OppositionMotifView {
  code: string;
  label: string;
  forbidden: boolean;
  sourceRef?: string;
  status: OppositionMotifStatus;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  validatedBy?: string;
  validatedAt?: string;
}

function holidayView(e: MobileHoliday): MobileHolidayView {
  const kind = e.kind as MobileHolidayKind;
  return {
    id: e.id,
    date: e.date,
    kind,
    label: MOBILE_HOLIDAY_KIND_LABELS[kind] ?? e.kind,
    hijriYear: e.hijriYear ?? undefined,
    status: e.status as MobileHolidayStatus,
    sourceRef: e.sourceRef ?? undefined,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
    confirmedBy: e.confirmedBy ?? undefined,
    confirmedAt: e.confirmedAt?.toISOString(),
  };
}

function circumstanceView(e: ConstatCircumstance): ConstatCircumstanceView {
  return {
    number: e.number,
    labelFr: e.labelFr,
    labelAr: e.labelAr ?? undefined,
    status: e.status as ConstatCircumstanceStatus,
    createdBy: e.createdBy,
    updatedBy: e.updatedBy ?? undefined,
    validatedBy: e.validatedBy ?? undefined,
    validatedAt: e.validatedAt?.toISOString(),
  };
}

function motifView(e: OppositionMotif): OppositionMotifView {
  return {
    code: e.code,
    label: e.label,
    forbidden: e.forbidden,
    sourceRef: e.sourceRef ?? undefined,
    status: e.status as OppositionMotifStatus,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
    updatedBy: e.updatedBy ?? undefined,
    validatedBy: e.validatedBy ?? undefined,
    validatedAt: e.validatedAt?.toISOString(),
  };
}

const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);

/**
 * Référentiels conventionnels de l'écran 12 : fériés mobiles (§2),
 * circonstances du constat et motifs d'opposition (§1). Contrôles métier et
 * règle des quatre yeux toujours AVANT la closure de `withDegradedFallback`.
 */
@Injectable()
export class ConventionReferentialService {
  /** Repli mémoire — mode dégradé, persistant pour la durée du process. */
  private readonly memory: {
    holidays: MobileHolidayView[];
    circumstances: ConstatCircumstanceView[];
    motifs: OppositionMotifView[];
  };

  constructor(
    @InjectRepository(MobileHoliday) private readonly holidays: EntityRepository<MobileHoliday>,
    @InjectRepository(ConstatCircumstance) private readonly circumstances: EntityRepository<ConstatCircumstance>,
    @InjectRepository(OppositionMotif) private readonly motifs: EntityRepository<OppositionMotif>,
  ) {
    const seededAt = new Date().toISOString();
    this.memory = {
      holidays: [],
      circumstances: CONSTAT_CIRCUMSTANCES_SEED.map((c) => ({ number: c.number, labelFr: c.labelFr, status: 'STANDARD_A_CONFIRMER', createdBy: SEED_AUTHOR })),
      motifs: OPPOSITION_MOTIFS_SEED.map((m) => ({ ...m, status: 'SAISI', createdBy: SEED_AUTHOR, createdAt: seededAt })),
    };
  }

  // ---- Fériés mobiles (§2) ----------------------------------------------

  async listHolidays(year?: number): Promise<MobileHolidayView[]> {
    const all = await withDegradedFallback(
      'ConventionReferentialService.listHolidays',
      async () => (await this.holidays.findAll({ orderBy: { date: 'ASC' } })).map(holidayView),
      () => [...this.memory.holidays].sort(byDate),
    );
    return year === undefined ? all : all.filter((h) => h.date.startsWith(`${year}-`));
  }

  private async getHoliday(id: string): Promise<MobileHolidayView> {
    const h = (await this.listHolidays()).find((x) => x.id === id);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Férié mobile introuvable.' });
    return h;
  }

  private async assertHolidayUnique(date: string, kind: string, exceptId?: string): Promise<void> {
    const clash = (await this.listHolidays()).find((h) => h.date === date && h.kind === kind && h.id !== exceptId);
    if (clash) throw new ConflictException({ code: 'CONFLICT', message: `Un férié "${kind}" existe déjà le ${date}.` });
  }

  async createHoliday(dto: CreateMobileHolidayDto, user: AuthenticatedUser): Promise<MobileHolidayView> {
    assertIsoDate(dto.date, 'date');
    await this.assertHolidayUnique(dto.date, dto.kind);
    return withDegradedFallback(
      'ConventionReferentialService.createHoliday',
      async () => {
        const e = this.holidays.create({ date: dto.date, kind: dto.kind, hijriYear: dto.hijriYear, status: 'PREVISIONNEL', createdBy: user.id, createdAt: new Date() });
        await this.holidays.getEntityManager().persistAndFlush(e);
        return holidayView(e);
      },
      () => {
        const view: MobileHolidayView = {
          id: randomUUID(),
          date: dto.date,
          kind: dto.kind,
          label: MOBILE_HOLIDAY_KIND_LABELS[dto.kind],
          hijriYear: dto.hijriYear,
          status: 'PREVISIONNEL',
          createdBy: user.id,
          createdAt: new Date().toISOString(),
        };
        this.memory.holidays.push(view);
        return view;
      },
    );
  }

  async updateHoliday(id: string, dto: UpdateMobileHolidayDto): Promise<MobileHolidayView> {
    const current = await this.getHoliday(id);
    if (current.status === 'CONFIRME') {
      throw new ConflictException({ code: 'CONFLICT', message: 'Un férié confirmé ne se modifie plus : la date confirmée provient du communiqué officiel.' });
    }
    if (dto.date) assertIsoDate(dto.date, 'date');
    await this.assertHolidayUnique(dto.date ?? current.date, dto.kind ?? current.kind, id);
    return this.writeHoliday(id, { date: dto.date, kind: dto.kind, hijriYear: dto.hijriYear }, 'updateHoliday');
  }

  async confirmHoliday(id: string, dto: ConfirmMobileHolidayDto, user: AuthenticatedUser): Promise<MobileHolidayView> {
    const current = await this.getHoliday(id);
    if (current.status === 'CONFIRME') throw new ConflictException({ code: 'CONFLICT', message: 'Férié déjà confirmé.' });
    const sourceRef = dto.sourceRef.trim();
    if (!sourceRef) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'La confirmation exige la référence du communiqué ou du décret.' });
    if (dto.date) {
      assertIsoDate(dto.date, 'date');
      await this.assertHolidayUnique(dto.date, current.kind, id);
    }
    return this.writeHoliday(id, { date: dto.date, status: 'CONFIRME', sourceRef, confirmedBy: user.id, confirmedAt: new Date() }, 'confirmHoliday');
  }

  async removeHoliday(id: string): Promise<{ id: string; deleted: true }> {
    const current = await this.getHoliday(id);
    if (current.status === 'CONFIRME') throw new ConflictException({ code: 'CONFLICT', message: 'Un férié confirmé ne se supprime pas.' });
    return withDegradedFallback(
      'ConventionReferentialService.removeHoliday',
      async () => {
        const e = await this.holidays.findOneOrFail({ id });
        await this.holidays.getEntityManager().removeAndFlush(e);
        return { id, deleted: true as const };
      },
      () => {
        const idx = this.memory.holidays.findIndex((h) => h.id === id);
        if (idx < 0) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Férié mobile introuvable (mode dégradé).' });
        this.memory.holidays.splice(idx, 1);
        return { id, deleted: true as const };
      },
    );
  }

  private writeHoliday(
    id: string,
    patch: { date?: string; kind?: MobileHolidayKind; hijriYear?: number; status?: MobileHolidayStatus; sourceRef?: string; confirmedBy?: string; confirmedAt?: Date },
    scope: string,
  ): Promise<MobileHolidayView> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    return withDegradedFallback(
      `ConventionReferentialService.${scope}`,
      async () => {
        const e = await this.holidays.findOneOrFail({ id });
        this.holidays.assign(e, defined);
        await this.holidays.getEntityManager().flush();
        return holidayView(e);
      },
      () => {
        const row = this.memory.holidays.find((h) => h.id === id);
        if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Férié mobile introuvable (mode dégradé).' });
        const { confirmedAt, kind, ...rest } = defined as typeof patch;
        Object.assign(row, rest);
        if (kind) Object.assign(row, { kind, label: MOBILE_HOLIDAY_KIND_LABELS[kind] });
        if (confirmedAt) row.confirmedAt = confirmedAt.toISOString();
        return row;
      },
    );
  }

  /**
   * Union des fériés fixes et mobiles (prévisionnels compris : ils comptent
   * dès leur saisie, décision PO §2), bornes incluses.
   */
  async calendarHolidays(from?: string, to?: string): Promise<CalendarHolidayView[]> {
    if (from) assertIsoDate(from, 'from');
    if (to) assertIsoDate(to, 'to');
    if (from && to && from > to) throw new BadRequestException({ code: 'BAD_REQUEST', message: '"from" doit précéder ou égaler "to".' });
    const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
    const thisYear = new Date().getUTCFullYear();
    const fromYear = from ? Number(from.slice(0, 4)) : to ? Number(to.slice(0, 4)) : thisYear - 1;
    const toYear = to ? Number(to.slice(0, 4)) : from ? Number(from.slice(0, 4)) : thisYear + 1;
    if (toYear - fromYear > MAX_CALENDAR_SPAN_YEARS) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: `Période trop longue : ${MAX_CALENDAR_SPAN_YEARS} ans au plus.` });
    }
    const fixed: CalendarHolidayView[] = algeriaFixedHolidays(fromYear, toYear)
      .filter((h) => inRange(h.date))
      .map((h) => ({ date: h.date, label: h.label, type: 'FIXE', status: 'LEGAL' }));
    const mobile: CalendarHolidayView[] = (await this.listHolidays())
      .filter((h) => inRange(h.date))
      .map((h) => ({ date: h.date, label: h.label, type: 'MOBILE', kind: h.kind, status: h.status, sourceRef: h.sourceRef }));
    return [...fixed, ...mobile].sort(byDate);
  }

  async extraHolidays(from: string, to: string): Promise<string[]> {
    assertIsoDate(from, 'from');
    assertIsoDate(to, 'to');
    const mobile = (await this.listHolidays()).filter((h) => h.date >= from && h.date <= to);
    return [...new Set(mobile.map((h) => h.date))].sort();
  }

  // ---- Circonstances du constat (§1) ------------------------------------

  async listCircumstances(): Promise<ConstatCircumstanceView[]> {
    return withDegradedFallback(
      'ConventionReferentialService.listCircumstances',
      async () => (await this.circumstances.findAll({ orderBy: { number: 'ASC' } })).map(circumstanceView),
      () => [...this.memory.circumstances].sort((a, b) => a.number - b.number),
    );
  }

  private async getCircumstance(number: number): Promise<ConstatCircumstanceView> {
    const c = (await this.listCircumstances()).find((x) => x.number === number);
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: `Circonstance n° ${number} introuvable (1 à 17).` });
    return c;
  }

  /** Une modification fait repasser la valeur en attente de validation UAR. */
  async updateCircumstance(number: number, dto: UpdateConstatCircumstanceDto, user: AuthenticatedUser): Promise<ConstatCircumstanceView> {
    await this.getCircumstance(number);
    const patch = {
      ...(dto.labelFr !== undefined ? { labelFr: dto.labelFr } : {}),
      ...(dto.labelAr !== undefined ? { labelAr: dto.labelAr } : {}),
      status: 'STANDARD_A_CONFIRMER' as const,
      updatedBy: user.id,
      validatedBy: undefined,
      validatedAt: undefined,
    };
    return this.writeCircumstance(number, patch, 'updateCircumstance');
  }

  async validateCircumstance(number: number, user: AuthenticatedUser): Promise<ConstatCircumstanceView> {
    const current = await this.getCircumstance(number);
    if (current.status === 'VALIDE_UAR') throw new ConflictException({ code: 'ALREADY_VALIDATED', message: 'Circonstance déjà validée par l’UAR.' });
    assertFourEyes(user, [current.createdBy, current.updatedBy]);
    return this.writeCircumstance(number, { status: 'VALIDE_UAR', validatedBy: user.id, validatedAt: new Date() }, 'validateCircumstance');
  }

  private writeCircumstance(
    number: number,
    patch: { labelFr?: string; labelAr?: string; status: ConstatCircumstanceStatus; updatedBy?: string; validatedBy?: string; validatedAt?: Date },
    scope: string,
  ): Promise<ConstatCircumstanceView> {
    return withDegradedFallback(
      `ConventionReferentialService.${scope}`,
      async () => {
        const e = await this.circumstances.findOneOrFail({ number });
        this.circumstances.assign(e, { ...patch, validatedBy: patch.validatedBy ?? null, validatedAt: patch.validatedAt ?? null } as never);
        await this.circumstances.getEntityManager().flush();
        return circumstanceView(e);
      },
      () => {
        const row = this.memory.circumstances.find((c) => c.number === number);
        if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: `Circonstance n° ${number} introuvable (mode dégradé).` });
        const { validatedAt, ...rest } = patch;
        Object.assign(row, rest, { validatedAt: validatedAt?.toISOString() });
        return row;
      },
    );
  }

  // ---- Motifs d'opposition (§1) -----------------------------------------

  async listMotifs(): Promise<OppositionMotifView[]> {
    return withDegradedFallback(
      'ConventionReferentialService.listMotifs',
      async () => (await this.motifs.findAll({ orderBy: { code: 'ASC' } })).map(motifView),
      () => [...this.memory.motifs].sort((a, b) => a.code.localeCompare(b.code)),
    );
  }

  private async getMotif(code: string): Promise<OppositionMotifView> {
    const m = (await this.listMotifs()).find((x) => x.code === code);
    if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: `Motif d'opposition "${code}" introuvable.` });
    return m;
  }

  async createMotif(dto: CreateOppositionMotifDto, user: AuthenticatedUser): Promise<OppositionMotifView> {
    if ((await this.listMotifs()).some((m) => m.code === dto.code)) {
      throw new ConflictException({ code: 'CONFLICT', message: `Le motif "${dto.code}" existe déjà.` });
    }
    return withDegradedFallback(
      'ConventionReferentialService.createMotif',
      async () => {
        const e = this.motifs.create({
          code: dto.code,
          label: dto.label,
          forbidden: dto.forbidden ?? false,
          sourceRef: dto.sourceRef,
          status: 'SAISI',
          createdBy: user.id,
          createdAt: new Date(),
        });
        await this.motifs.getEntityManager().persistAndFlush(e);
        return motifView(e);
      },
      () => {
        const view: OppositionMotifView = {
          code: dto.code,
          label: dto.label,
          forbidden: dto.forbidden ?? false,
          sourceRef: dto.sourceRef,
          status: 'SAISI',
          createdBy: user.id,
          createdAt: new Date().toISOString(),
        };
        this.memory.motifs.push(view);
        return view;
      },
    );
  }

  /** Une modification fait repasser le motif en attente de validation UAR. */
  async updateMotif(code: string, dto: UpdateOppositionMotifDto, user: AuthenticatedUser): Promise<OppositionMotifView> {
    await this.getMotif(code);
    const patch = {
      ...(dto.label !== undefined ? { label: dto.label } : {}),
      ...(dto.forbidden !== undefined ? { forbidden: dto.forbidden } : {}),
      ...(dto.sourceRef !== undefined ? { sourceRef: dto.sourceRef } : {}),
      status: 'SAISI' as const,
      updatedBy: user.id,
    };
    return this.writeMotif(code, patch, true, 'updateMotif');
  }

  async validateMotif(code: string, user: AuthenticatedUser): Promise<OppositionMotifView> {
    const current = await this.getMotif(code);
    if (current.status === 'VALIDE_UAR') throw new ConflictException({ code: 'ALREADY_VALIDATED', message: 'Motif déjà validé par l’UAR.' });
    assertFourEyes(user, [current.createdBy, current.updatedBy]);
    return this.writeMotif(code, { status: 'VALIDE_UAR', validatedBy: user.id, validatedAt: new Date() }, false, 'validateMotif');
  }

  private writeMotif(
    code: string,
    patch: { label?: string; forbidden?: boolean; sourceRef?: string; status: OppositionMotifStatus; updatedBy?: string; validatedBy?: string; validatedAt?: Date },
    clearValidation: boolean,
    scope: string,
  ): Promise<OppositionMotifView> {
    return withDegradedFallback(
      `ConventionReferentialService.${scope}`,
      async () => {
        const e = await this.motifs.findOneOrFail({ code });
        this.motifs.assign(e, (clearValidation ? { ...patch, validatedBy: null, validatedAt: null } : patch) as never);
        await this.motifs.getEntityManager().flush();
        return motifView(e);
      },
      () => {
        const row = this.memory.motifs.find((m) => m.code === code);
        if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: `Motif d'opposition "${code}" introuvable (mode dégradé).` });
        const { validatedAt, ...rest } = patch;
        Object.assign(row, rest);
        if (validatedAt) row.validatedAt = validatedAt.toISOString();
        if (clearValidation) {
          delete row.validatedBy;
          delete row.validatedAt;
        }
        return row;
      },
    );
  }

  /** Contrôle d'un `reasonCode` d'opposition (RecoursModule) : 400 si inconnu ou interdit. */
  async assertOppositionMotifUsable(code: string): Promise<OppositionMotifView> {
    const motif = (await this.listMotifs()).find((m) => m.code === code);
    if (!motif) {
      throw new BadRequestException({ code: 'MOTIF_INCONNU', message: `Motif d'opposition "${code}" absent du catalogue des motifs.` });
    }
    if (motif.forbidden) {
      throw new BadRequestException({
        code: 'MOTIF_INTERDIT',
        message: `Le motif "${motif.label}" ne peut pas motiver une opposition (Art. 10 de la convention IDA ; guide pédagogique UAR, diapo 10)${motif.sourceRef ? ` — source : ${motif.sourceRef}` : ''}.`,
      });
    }
    // Décision PO (2026-10-19) : seul un motif validé UAR peut fonder une opposition.
    if (motif.status !== 'VALIDE_UAR') {
      throw new BadRequestException({ code: 'MOTIF_NON_VALIDE', message: `Le motif "${motif.label}" n'est pas encore validé par l'UAR.` });
    }
    return motif;
  }
}
