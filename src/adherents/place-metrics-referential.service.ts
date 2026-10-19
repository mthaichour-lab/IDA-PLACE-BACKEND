import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { CreateIrsamBenchmarkDto, CreateWilayaPopulationDto, UpdateWilayaPerimeterDto, UpdateWilayaPopulationDto } from './dto/place-referential.dto';
import { IrsamBenchmark, IrsamMeasureDefinition } from './entities/irsam-benchmark.entity';
import { Wilaya } from './entities/wilaya.entity';
import { WilayaPopulation } from './entities/wilaya-population.entity';
import { IrsamIndicator, IrsamStatus, POPULATION_SOURCE_TYPES, PopulationSourceType } from './place-referential.data';
import { assertFourEyes, assertIsoDate, populationInvalidReason } from './referential-rules';
import { buildWilayaSeeds, WilayaSeed } from './wilayas.data';

export interface WilayaPopulationView {
  id: string;
  wilayaCode: string;
  referenceYear: number;
  population: number;
  sourceType: PopulationSourceType;
  sourceRef: string;
  createdBy: string;
  createdAt: string;
  /** Faux si l'année précède le périmètre actuel de la wilaya (ou d'une wilaya fille) : jamais utilisée dans un calcul. */
  valid: boolean;
  invalidReason?: string;
}

export interface PopulationReference {
  population: number;
  referenceYear: number;
  sourceType: PopulationSourceType;
  sourceRef: string;
}

export interface PopulationImportRowResult {
  line: number;
  status: 'ACCEPTEE' | 'REJETEE';
  reason?: string;
  wilayaCode?: string;
  referenceYear?: number;
  population?: number;
}

export interface PopulationImportReport {
  fileName: string;
  totalRows: number;
  acceptedCount: number;
  rejectedCount: number;
  /** Tout ou rien : rien n'est écrit dès qu'une ligne est rejetée. */
  written: boolean;
  writtenCount: number;
  rows: PopulationImportRowResult[];
}

export interface IrsamBenchmarkView {
  id: string;
  indicator: IrsamIndicator;
  value: number;
  periodFrom: string;
  periodTo: string;
  measureDefinition: IrsamMeasureDefinition;
  sourceRef: string;
  status: IrsamStatus;
  createdBy: string;
  createdAt: string;
  validatedBy?: string;
  validatedAt?: string;
}

export interface IrsamReference {
  status: 'NON_RENSEIGNE' | 'EN_ATTENTE_VALIDATION' | 'VALIDE';
  /** Renseigné uniquement au statut `VALIDE` : une valeur non validée n'est jamais affichée comme officielle. */
  benchmark: IrsamBenchmarkView | null;
}

type StoredPopulation = Omit<WilayaPopulationView, 'valid' | 'invalidReason'>;

const MAX_POPULATION = 2_147_483_647; // colonne integer
const CSV_COLUMNS = 'code;annee;population;source_type;source_ref';

function populationRow(e: WilayaPopulation): StoredPopulation {
  return {
    id: e.id,
    wilayaCode: e.wilayaCode,
    referenceYear: e.referenceYear,
    population: e.population,
    sourceType: e.sourceType as PopulationSourceType,
    sourceRef: e.sourceRef,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
  };
}

function irsamView(e: IrsamBenchmark): IrsamBenchmarkView {
  return {
    id: e.id,
    indicator: e.indicator as IrsamIndicator,
    value: e.value,
    periodFrom: e.periodFrom,
    periodTo: e.periodTo,
    measureDefinition: e.measureDefinition,
    sourceRef: e.sourceRef,
    status: e.status as IrsamStatus,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
    validatedBy: e.validatedBy ?? undefined,
    validatedAt: e.validatedAt?.toISOString(),
  };
}

/**
 * Référentiels de place servant aux statistiques (écran 11) : périmètre des
 * wilayas, populations (§3) et référence IRSAM (§4). Aucune valeur
 * pré-remplie. Contrôles toujours AVANT la closure de `withDegradedFallback`.
 */
@Injectable()
export class PlaceMetricsReferentialService {
  /** Repli mémoire — mode dégradé, persistant pour la durée du process. */
  private readonly memory = {
    perimeters: new Map<string, { effectiveFrom?: string; parentCode?: string }>(),
    populations: [] as StoredPopulation[],
    irsam: [] as IrsamBenchmarkView[],
  };

  constructor(
    @InjectRepository(Wilaya) private readonly wilayas: EntityRepository<Wilaya>,
    @InjectRepository(WilayaPopulation) private readonly populations: EntityRepository<WilayaPopulation>,
    @InjectRepository(IrsamBenchmark) private readonly irsam: EntityRepository<IrsamBenchmark>,
  ) {}

  // ---- Wilayas ------------------------------------------------------------

  async listWilayas(): Promise<WilayaSeed[]> {
    return withDegradedFallback(
      'PlaceMetricsReferentialService.listWilayas',
      async () => {
        const rows = await this.wilayas.findAll({ orderBy: { code: 'ASC' } });
        if (rows.length === 0) throw new Error('table wilaya vide');
        return rows.map((w) => ({
          code: w.code,
          name: w.name,
          nameAr: w.nameAr,
          region: w.region,
          col: w.col,
          row: w.row,
          lat: w.lat,
          lng: w.lng,
          effectiveFrom: w.effectiveFrom ?? undefined,
          parentCode: w.parentCode ?? undefined,
        }));
      },
      () => buildWilayaSeeds().map((w) => ({ ...w, ...this.memory.perimeters.get(w.code) })),
    );
  }

  async updateWilayaPerimeter(code: string, dto: UpdateWilayaPerimeterDto): Promise<WilayaSeed> {
    const all = await this.listWilayas();
    const current = all.find((w) => w.code === code);
    if (!current) throw new NotFoundException({ code: 'NOT_FOUND', message: `Wilaya "${code}" introuvable.` });
    if (dto.effectiveFrom) assertIsoDate(dto.effectiveFrom, 'effectiveFrom');
    if (dto.parentCode) {
      if (dto.parentCode === code) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Une wilaya ne peut pas être sa propre wilaya mère.' });
      if (!all.some((w) => w.code === dto.parentCode)) throw new BadRequestException({ code: 'BAD_REQUEST', message: `Wilaya mère "${dto.parentCode}" introuvable.` });
    }
    const patch: { effectiveFrom?: string | null; parentCode?: string | null } = {};
    if (dto.effectiveFrom !== undefined) patch.effectiveFrom = dto.effectiveFrom;
    if (dto.parentCode !== undefined) patch.parentCode = dto.parentCode;
    return withDegradedFallback(
      'PlaceMetricsReferentialService.updateWilayaPerimeter',
      async () => {
        const w = await this.wilayas.findOne({ code });
        if (!w) throw new Error('wilaya absente de la table (seed non exécuté)');
        this.wilayas.assign(w, patch as never);
        await this.wilayas.getEntityManager().flush();
        return { ...current, effectiveFrom: w.effectiveFrom ?? undefined, parentCode: w.parentCode ?? undefined };
      },
      () => {
        const next = { ...this.memory.perimeters.get(code) };
        if (patch.effectiveFrom !== undefined) next.effectiveFrom = patch.effectiveFrom ?? undefined;
        if (patch.parentCode !== undefined) next.parentCode = patch.parentCode ?? undefined;
        this.memory.perimeters.set(code, next);
        return { ...current, ...next };
      },
    );
  }

  // ---- Populations (§3) -----------------------------------------------------

  private async storedPopulations(): Promise<StoredPopulation[]> {
    return withDegradedFallback(
      'PlaceMetricsReferentialService.listPopulations',
      async () => (await this.populations.findAll({ orderBy: { wilayaCode: 'ASC', referenceYear: 'ASC' } })).map(populationRow),
      () => [...this.memory.populations].sort((a, b) => a.wilayaCode.localeCompare(b.wilayaCode) || a.referenceYear - b.referenceYear),
    );
  }

  async listPopulations(wilayaCode?: string): Promise<WilayaPopulationView[]> {
    const [stored, wilayas] = await Promise.all([this.storedPopulations(), this.listWilayas()]);
    return stored
      .filter((p) => !wilayaCode || p.wilayaCode === wilayaCode)
      .map((p) => {
        const invalidReason = populationInvalidReason(p.wilayaCode, p.referenceYear, wilayas);
        return { ...p, valid: !invalidReason, ...(invalidReason ? { invalidReason } : {}) };
      });
  }

  /**
   * Population de référence par wilaya pour l'année étudiée : la plus récente
   * des populations valides d'année ≤ `year`. Aucune interpolation.
   */
  async populationReferences(year: number): Promise<Record<string, PopulationReference>> {
    const out: Record<string, PopulationReference> = {};
    for (const p of await this.listPopulations()) {
      if (!p.valid || p.referenceYear > year) continue;
      const prev = out[p.wilayaCode];
      if (!prev || p.referenceYear > prev.referenceYear) {
        out[p.wilayaCode] = { population: p.population, referenceYear: p.referenceYear, sourceType: p.sourceType, sourceRef: p.sourceRef };
      }
    }
    return out;
  }

  async createPopulation(dto: CreateWilayaPopulationDto, user: AuthenticatedUser): Promise<WilayaPopulationView> {
    const [stored, wilayas] = await Promise.all([this.storedPopulations(), this.listWilayas()]);
    if (!wilayas.some((w) => w.code === dto.wilayaCode)) throw new BadRequestException({ code: 'BAD_REQUEST', message: `Wilaya "${dto.wilayaCode}" introuvable.` });
    if (stored.some((p) => p.wilayaCode === dto.wilayaCode && p.referenceYear === dto.referenceYear)) {
      throw new ConflictException({ code: 'CONFLICT', message: `Une population existe déjà pour la wilaya ${dto.wilayaCode} en ${dto.referenceYear}.` });
    }
    const invalidReason = populationInvalidReason(dto.wilayaCode, dto.referenceYear, wilayas);
    if (invalidReason) throw new BadRequestException({ code: 'POPULATION_INVALIDE', message: invalidReason });
    const [created] = await this.persistPopulations([{ ...dto, sourceRef: dto.sourceRef.trim() }], user, 'createPopulation');
    return { ...created, valid: true };
  }

  async updatePopulation(id: string, dto: UpdateWilayaPopulationDto): Promise<WilayaPopulationView> {
    if (!(await this.storedPopulations()).some((p) => p.id === id)) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Population introuvable.' });
    }
    const patch = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    await withDegradedFallback(
      'PlaceMetricsReferentialService.updatePopulation',
      async () => {
        const e = await this.populations.findOneOrFail({ id });
        this.populations.assign(e, patch);
        await this.populations.getEntityManager().flush();
      },
      () => {
        const row = this.memory.populations.find((p) => p.id === id);
        if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Population introuvable (mode dégradé).' });
        Object.assign(row, patch);
      },
    );
    return (await this.listPopulations()).find((p) => p.id === id)!;
  }

  private persistPopulations(
    items: Array<{ wilayaCode: string; referenceYear: number; population: number; sourceType: PopulationSourceType; sourceRef: string }>,
    user: AuthenticatedUser,
    scope: string,
  ): Promise<StoredPopulation[]> {
    return withDegradedFallback(
      `PlaceMetricsReferentialService.${scope}`,
      async () => {
        const em = this.populations.getEntityManager();
        const entities = items.map((i) => this.populations.create({ ...i, createdBy: user.id, createdAt: new Date() }));
        for (const e of entities) em.persist(e);
        await em.flush();
        return entities.map(populationRow);
      },
      () => {
        const rows = items.map((i) => ({ id: randomUUID(), ...i, createdBy: user.id, createdAt: new Date().toISOString() }));
        this.memory.populations.push(...rows);
        return rows;
      },
    );
  }

  /** Import CSV `code;annee;population;source_type;source_ref`, tout ou rien, rapport ligne par ligne. */
  async importPopulations(fileName: string, buffer: Buffer, user: AuthenticatedUser): Promise<PopulationImportReport> {
    const lines = buffer
      .toString('utf8')
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter((l) => l.text.length > 0);
    if (lines.length > 0 && lines[0].text.toLowerCase().startsWith('code;')) lines.shift();
    if (lines.length === 0) throw new BadRequestException({ code: 'BAD_REQUEST', message: `Fichier vide : colonnes attendues ${CSV_COLUMNS}.` });

    const [stored, wilayas] = await Promise.all([this.storedPopulations(), this.listWilayas()]);
    const seenInFile = new Map<string, number>();
    const accepted: Array<{ wilayaCode: string; referenceYear: number; population: number; sourceType: PopulationSourceType; sourceRef: string }> = [];
    const rows: PopulationImportRowResult[] = [];

    for (const { line, text } of lines) {
      const fields = text.split(';').map((f) => f.trim());
      const reject = (reason: string, extra: Partial<PopulationImportRowResult> = {}) => rows.push({ line, status: 'REJETEE', reason, ...extra });
      if (fields.length !== 5) {
        reject(`5 colonnes attendues (${CSV_COLUMNS}), ${fields.length} trouvée(s).`);
        continue;
      }
      const [rawCode, rawYear, rawPopulation, sourceType, sourceRef] = fields;
      if (!/^\d{1,2}$/.test(rawCode)) {
        reject(`Code wilaya invalide : "${rawCode}".`);
        continue;
      }
      const wilayaCode = rawCode.padStart(2, '0');
      const referenceYear = /^\d{4}$/.test(rawYear) ? Number(rawYear) : NaN;
      const population = /^\d+$/.test(rawPopulation.replace(/[\s  ]/g, '')) ? Number(rawPopulation.replace(/[\s  ]/g, '')) : NaN;
      const ctx = { wilayaCode, referenceYear: Number.isNaN(referenceYear) ? undefined : referenceYear };
      if (!wilayas.some((w) => w.code === wilayaCode)) reject(`Wilaya "${wilayaCode}" introuvable.`, ctx);
      else if (Number.isNaN(referenceYear) || referenceYear < 1900 || referenceYear > 2200) reject(`Année invalide : "${rawYear}".`, ctx);
      else if (Number.isNaN(population) || population < 1 || population > MAX_POPULATION) reject(`Population invalide : "${rawPopulation}".`, ctx);
      else if (!(POPULATION_SOURCE_TYPES as readonly string[]).includes(sourceType)) reject(`source_type invalide : "${sourceType}" (attendu : ${POPULATION_SOURCE_TYPES.join(', ')}).`, ctx);
      else if (!sourceRef || sourceRef.length > 255) reject('source_ref obligatoire (255 caractères au plus).', ctx);
      else if (seenInFile.has(`${wilayaCode}|${referenceYear}`)) reject(`Doublon de la ligne ${seenInFile.get(`${wilayaCode}|${referenceYear}`)} (même wilaya, même année).`, ctx);
      else if (stored.some((p) => p.wilayaCode === wilayaCode && p.referenceYear === referenceYear)) reject('Population déjà saisie pour cette wilaya et cette année.', ctx);
      else {
        const invalidReason = populationInvalidReason(wilayaCode, referenceYear, wilayas);
        if (invalidReason) reject(invalidReason, ctx);
        else {
          seenInFile.set(`${wilayaCode}|${referenceYear}`, line);
          accepted.push({ wilayaCode, referenceYear, population, sourceType: sourceType as PopulationSourceType, sourceRef });
          rows.push({ line, status: 'ACCEPTEE', wilayaCode, referenceYear, population });
        }
      }
    }

    const rejectedCount = rows.filter((r) => r.status === 'REJETEE').length;
    const written = rejectedCount === 0;
    if (written) await this.persistPopulations(accepted, user, 'importPopulations');
    return {
      fileName,
      totalRows: rows.length,
      acceptedCount: accepted.length,
      rejectedCount,
      written,
      writtenCount: written ? accepted.length : 0,
      rows,
    };
  }

  // ---- Référence IRSAM (§4) -------------------------------------------------

  async listIrsam(): Promise<IrsamBenchmarkView[]> {
    return withDegradedFallback(
      'PlaceMetricsReferentialService.listIrsam',
      async () => (await this.irsam.findAll({ orderBy: { createdAt: 'DESC' } })).map(irsamView),
      () => [...this.memory.irsam].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }

  private async getIrsam(id: string): Promise<IrsamBenchmarkView> {
    const b = (await this.listIrsam()).find((x) => x.id === id);
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Référence IRSAM introuvable.' });
    return b;
  }

  async createIrsam(dto: CreateIrsamBenchmarkDto, user: AuthenticatedUser): Promise<IrsamBenchmarkView> {
    assertIsoDate(dto.periodFrom, 'periodFrom');
    assertIsoDate(dto.periodTo, 'periodTo');
    if (dto.periodFrom > dto.periodTo) throw new BadRequestException({ code: 'BAD_REQUEST', message: '"periodFrom" doit précéder ou égaler "periodTo".' });
    const measureDefinition: IrsamMeasureDefinition = {
      startEvent: dto.measureDefinition.startEvent,
      endEvent: dto.measureDefinition.endEvent,
      scope: dto.measureDefinition.scope,
    };
    return withDegradedFallback(
      'PlaceMetricsReferentialService.createIrsam',
      async () => {
        const e = this.irsam.create({
          indicator: dto.indicator,
          value: dto.value,
          periodFrom: dto.periodFrom,
          periodTo: dto.periodTo,
          measureDefinition,
          sourceRef: dto.sourceRef,
          status: 'SAISI',
          createdBy: user.id,
          createdAt: new Date(),
        });
        await this.irsam.getEntityManager().persistAndFlush(e);
        return irsamView(e);
      },
      () => {
        const view: IrsamBenchmarkView = {
          id: randomUUID(),
          indicator: dto.indicator,
          value: dto.value,
          periodFrom: dto.periodFrom,
          periodTo: dto.periodTo,
          measureDefinition,
          sourceRef: dto.sourceRef,
          status: 'SAISI',
          createdBy: user.id,
          createdAt: new Date().toISOString(),
        };
        this.memory.irsam.push(view);
        return view;
      },
    );
  }

  /** Validation UAR : archive la référence précédemment validée pour le même indicateur (une seule référence officielle). */
  async validateIrsam(id: string, user: AuthenticatedUser): Promise<IrsamBenchmarkView> {
    const current = await this.getIrsam(id);
    if (current.status !== 'SAISI') {
      throw new ConflictException({ code: 'ALREADY_VALIDATED', message: `Seule une référence au statut SAISI peut être validée (statut actuel : ${current.status}).` });
    }
    assertFourEyes(user, [current.createdBy]);
    const validatedAt = new Date();
    return withDegradedFallback(
      'PlaceMetricsReferentialService.validateIrsam',
      async () => {
        const previous = await this.irsam.find({ indicator: current.indicator, status: 'VALIDE_UAR' });
        for (const p of previous) p.status = 'ARCHIVE';
        const e = await this.irsam.findOneOrFail({ id });
        this.irsam.assign(e, { status: 'VALIDE_UAR', validatedBy: user.id, validatedAt });
        await this.irsam.getEntityManager().flush();
        return irsamView(e);
      },
      () => {
        for (const p of this.memory.irsam) if (p.indicator === current.indicator && p.status === 'VALIDE_UAR') p.status = 'ARCHIVE';
        const row = this.memory.irsam.find((b) => b.id === id);
        if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Référence IRSAM introuvable (mode dégradé).' });
        Object.assign(row, { status: 'VALIDE_UAR', validatedBy: user.id, validatedAt: validatedAt.toISOString() });
        return row;
      },
    );
  }

  async archiveIrsam(id: string): Promise<IrsamBenchmarkView> {
    const current = await this.getIrsam(id);
    if (current.status === 'ARCHIVE') throw new ConflictException({ code: 'CONFLICT', message: 'Référence IRSAM déjà archivée.' });
    return withDegradedFallback(
      'PlaceMetricsReferentialService.archiveIrsam',
      async () => {
        const e = await this.irsam.findOneOrFail({ id });
        e.status = 'ARCHIVE';
        await this.irsam.getEntityManager().flush();
        return irsamView(e);
      },
      () => {
        const row = this.memory.irsam.find((b) => b.id === id);
        if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Référence IRSAM introuvable (mode dégradé).' });
        row.status = 'ARCHIVE';
        return row;
      },
    );
  }

  async irsamReference(indicator: IrsamIndicator): Promise<IrsamReference> {
    const forIndicator = (await this.listIrsam()).filter((b) => b.indicator === indicator);
    const validated = forIndicator
      .filter((b) => b.status === 'VALIDE_UAR')
      .sort((a, b) => (b.validatedAt ?? '').localeCompare(a.validatedAt ?? ''))[0];
    if (validated) return { status: 'VALIDE', benchmark: validated };
    return { status: forIndicator.some((b) => b.status === 'SAISI') ? 'EN_ATTENTE_VALIDATION' : 'NON_RENSEIGNE', benchmark: null };
  }
}
