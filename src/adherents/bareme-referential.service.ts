import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { assertBaremeParts, PublishedBaremeCase, PublishedVehicleCategory } from './bareme-rules';
import {
  CreateBaremeCaseDto,
  CreateBaremeVersionDto,
  CreateVehicleCategoryDto,
  UpdateBaremeCaseDto,
  UpdateBaremeVersionDto,
  UpdateVehicleCategoryDto,
} from './dto/place-referential.dto';
import { BaremeCase } from './entities/bareme-case.entity';
import { BaremeVersion } from './entities/bareme-version.entity';
import { VehicleCategory } from './entities/vehicle-category.entity';
import { BaremeVersionStatus, VehicleCategoryStatus } from './place-referential.data';
import { assertFourEyes } from './referential-rules';

export interface BaremeCaseView {
  code: string;
  label: string;
  partA: number;
  partB: number;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
}

export interface BaremeVersionView {
  id: string;
  label: string;
  status: BaremeVersionStatus;
  sourceRef?: string;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  validatedBy?: string;
  validatedAt?: string;
  cases: BaremeCaseView[];
}

export interface VehicleCategoryView {
  code: string;
  label: string;
  status: VehicleCategoryStatus;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  validatedBy?: string;
  validatedAt?: string;
}

type StoredVersion = Omit<BaremeVersionView, 'cases'>;
type StoredCase = BaremeCaseView & { versionId: string };

function versionRow(e: BaremeVersion): StoredVersion {
  return {
    id: e.id,
    label: e.label,
    status: e.status as BaremeVersionStatus,
    sourceRef: e.sourceRef ?? undefined,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
    updatedBy: e.updatedBy ?? undefined,
    validatedBy: e.validatedBy ?? undefined,
    validatedAt: e.validatedAt?.toISOString(),
  };
}

function caseRow(e: BaremeCase): StoredCase {
  return {
    versionId: e.versionId,
    code: e.code,
    label: e.label,
    partA: e.partA,
    partB: e.partB,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
    updatedBy: e.updatedBy ?? undefined,
  };
}

function categoryView(e: VehicleCategory): VehicleCategoryView {
  return {
    code: e.code,
    label: e.label,
    status: e.status as VehicleCategoryStatus,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
    updatedBy: e.updatedBy ?? undefined,
    validatedBy: e.validatedBy ?? undefined,
    validatedAt: e.validatedAt?.toISOString(),
  };
}

function publicCase({ versionId: _versionId, ...rest }: StoredCase): BaremeCaseView {
  return rest;
}

/**
 * Barème Art. 14 et catégories de véhicule (décision PO §5). Rien n'est
 * pré-rempli : ni codes, ni parts, ni catégories. Contrôles métier et quatre
 * yeux toujours AVANT la closure de `withDegradedFallback`.
 */
@Injectable()
export class BaremeReferentialService {
  /** Repli mémoire — mode dégradé, persistant pour la durée du process. */
  private readonly memory = {
    versions: [] as StoredVersion[],
    cases: [] as StoredCase[],
    categories: [] as VehicleCategoryView[],
  };

  constructor(
    @InjectRepository(BaremeVersion) private readonly versions: EntityRepository<BaremeVersion>,
    @InjectRepository(BaremeCase) private readonly cases: EntityRepository<BaremeCase>,
    @InjectRepository(VehicleCategory) private readonly categories: EntityRepository<VehicleCategory>,
  ) {}

  // ---- Versions du barème ---------------------------------------------------

  private storedVersions(): Promise<StoredVersion[]> {
    return withDegradedFallback(
      'BaremeReferentialService.listVersions',
      async () => (await this.versions.findAll({ orderBy: { createdAt: 'ASC' } })).map(versionRow),
      () => [...this.memory.versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  }

  private storedCases(): Promise<StoredCase[]> {
    return withDegradedFallback(
      'BaremeReferentialService.listCases',
      async () => (await this.cases.findAll({ orderBy: { code: 'ASC' } })).map(caseRow),
      () => [...this.memory.cases].sort((a, b) => a.code.localeCompare(b.code)),
    );
  }

  async listVersions(): Promise<BaremeVersionView[]> {
    const [versions, cases] = await Promise.all([this.storedVersions(), this.storedCases()]);
    return versions.map((v) => ({ ...v, cases: cases.filter((c) => c.versionId === v.id).map(publicCase) }));
  }

  async getVersion(id: string): Promise<BaremeVersionView> {
    const v = (await this.listVersions()).find((x) => x.id === id);
    if (!v) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Version du barème introuvable.' });
    return v;
  }

  private async getDraft(id: string): Promise<BaremeVersionView> {
    const v = await this.getVersion(id);
    if (v.status !== 'BROUILLON') {
      throw new ConflictException({
        code: 'VERSION_IMMUABLE',
        message: `Version « ${v.label} » au statut ${v.status} : elle ne se modifie plus, créez une nouvelle version.`,
      });
    }
    return v;
  }

  private async assertLabelFree(label: string, exceptId?: string): Promise<void> {
    if ((await this.storedVersions()).some((v) => v.label === label && v.id !== exceptId)) {
      throw new ConflictException({ code: 'CONFLICT', message: `Une version « ${label} » existe déjà.` });
    }
  }

  async createVersion(dto: CreateBaremeVersionDto, user: AuthenticatedUser): Promise<BaremeVersionView> {
    const label = dto.label.trim();
    await this.assertLabelFree(label);
    const stored = await withDegradedFallback(
      'BaremeReferentialService.createVersion',
      async () => {
        const e = this.versions.create({ label, sourceRef: dto.sourceRef, status: 'BROUILLON', createdBy: user.id, createdAt: new Date() });
        await this.versions.getEntityManager().persistAndFlush(e);
        return versionRow(e);
      },
      () => {
        const row: StoredVersion = { id: randomUUID(), label, sourceRef: dto.sourceRef, status: 'BROUILLON', createdBy: user.id, createdAt: new Date().toISOString() };
        this.memory.versions.push(row);
        return row;
      },
    );
    return { ...stored, cases: [] };
  }

  async updateVersion(id: string, dto: UpdateBaremeVersionDto, user: AuthenticatedUser): Promise<BaremeVersionView> {
    await this.getDraft(id);
    const label = dto.label?.trim();
    if (label) await this.assertLabelFree(label, id);
    await this.writeVersion(id, { ...(label ? { label } : {}), ...(dto.sourceRef !== undefined ? { sourceRef: dto.sourceRef } : {}), updatedBy: user.id }, 'updateVersion');
    return this.getVersion(id);
  }

  /** Quatre yeux : le validateur n'a ni créé ni modifié la version, ni aucun de ses cas. */
  async validateVersion(id: string, user: AuthenticatedUser): Promise<BaremeVersionView> {
    const v = await this.getVersion(id);
    if (v.status !== 'BROUILLON') {
      throw new ConflictException({ code: 'ALREADY_VALIDATED', message: `Seule une version BROUILLON peut être validée (statut actuel : ${v.status}).` });
    }
    if (v.cases.length === 0) throw new BadRequestException({ code: 'BAREME_VIDE', message: 'Une version sans aucun cas ne peut pas être validée.' });
    for (const c of v.cases) assertBaremeParts(c.partA, c.partB);
    assertFourEyes(user, [v.createdBy, v.updatedBy, ...v.cases.flatMap((c) => [c.createdBy, c.updatedBy])]);
    await this.writeVersion(id, { status: 'VALIDE_UAR', validatedBy: user.id, validatedAt: new Date() }, 'validateVersion');
    return this.getVersion(id);
  }

  async archiveVersion(id: string): Promise<BaremeVersionView> {
    const v = await this.getVersion(id);
    if (v.status !== 'VALIDE_UAR') {
      throw new ConflictException({ code: 'CONFLICT', message: `Seule une version VALIDE_UAR peut être archivée (statut actuel : ${v.status}).` });
    }
    await this.writeVersion(id, { status: 'ARCHIVE' }, 'archiveVersion');
    return this.getVersion(id);
  }

  private writeVersion(
    id: string,
    patch: { label?: string; sourceRef?: string; status?: BaremeVersionStatus; updatedBy?: string; validatedBy?: string; validatedAt?: Date },
    scope: string,
  ): Promise<void> {
    return withDegradedFallback(
      `BaremeReferentialService.${scope}`,
      async () => {
        const e = await this.versions.findOneOrFail({ id });
        this.versions.assign(e, patch);
        await this.versions.getEntityManager().flush();
      },
      () => {
        const row = this.memory.versions.find((v) => v.id === id);
        if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Version du barème introuvable (mode dégradé).' });
        const { validatedAt, ...rest } = patch;
        Object.assign(row, rest);
        if (validatedAt) row.validatedAt = validatedAt.toISOString();
      },
    );
  }

  // ---- Cas d'une version BROUILLON ------------------------------------------

  async addCase(versionId: string, dto: CreateBaremeCaseDto, user: AuthenticatedUser): Promise<BaremeVersionView> {
    const v = await this.getDraft(versionId);
    if (v.cases.some((c) => c.code === dto.code)) throw new ConflictException({ code: 'CONFLICT', message: `Le code « ${dto.code} » existe déjà dans cette version.` });
    assertBaremeParts(dto.partA, dto.partB);
    const item = { versionId, code: dto.code, label: dto.label, partA: dto.partA, partB: dto.partB, createdBy: user.id };
    await withDegradedFallback(
      'BaremeReferentialService.addCase',
      async () => {
        const e = this.cases.create({ ...item, createdAt: new Date() });
        await this.cases.getEntityManager().persistAndFlush(e);
      },
      () => {
        this.memory.cases.push({ ...item, createdAt: new Date().toISOString() });
      },
    );
    return this.getVersion(versionId);
  }

  async updateCase(versionId: string, code: string, dto: UpdateBaremeCaseDto, user: AuthenticatedUser): Promise<BaremeVersionView> {
    const v = await this.getDraft(versionId);
    const current = v.cases.find((c) => c.code === code);
    if (!current) throw new NotFoundException({ code: 'NOT_FOUND', message: `Cas « ${code} » introuvable dans cette version.` });
    assertBaremeParts(dto.partA ?? current.partA, dto.partB ?? current.partB);
    const patch = { ...Object.fromEntries(Object.entries(dto).filter(([, val]) => val !== undefined)), updatedBy: user.id };
    await withDegradedFallback(
      'BaremeReferentialService.updateCase',
      async () => {
        const e = await this.cases.findOneOrFail({ versionId, code });
        this.cases.assign(e, patch);
        await this.cases.getEntityManager().flush();
      },
      () => {
        const row = this.memory.cases.find((c) => c.versionId === versionId && c.code === code);
        if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Cas du barème introuvable (mode dégradé).' });
        Object.assign(row, patch);
      },
    );
    return this.getVersion(versionId);
  }

  async removeCase(versionId: string, code: string, user: AuthenticatedUser): Promise<BaremeVersionView> {
    const v = await this.getDraft(versionId);
    if (!v.cases.some((c) => c.code === code)) throw new NotFoundException({ code: 'NOT_FOUND', message: `Cas « ${code} » introuvable dans cette version.` });
    await withDegradedFallback(
      'BaremeReferentialService.removeCase',
      async () => {
        const e = await this.cases.findOneOrFail({ versionId, code });
        await this.cases.getEntityManager().removeAndFlush(e);
      },
      () => {
        const idx = this.memory.cases.findIndex((c) => c.versionId === versionId && c.code === code);
        if (idx < 0) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Cas du barème introuvable (mode dégradé).' });
        this.memory.cases.splice(idx, 1);
      },
    );
    // Une suppression est une saisie : son auteur ne peut plus valider la version.
    await this.writeVersion(versionId, { updatedBy: user.id }, 'removeCase');
    return this.getVersion(versionId);
  }

  /** Cas des versions `VALIDE_UAR` uniquement : un brouillon ou une version archivée n'entre jamais dans un calcul. */
  async publishedCases(): Promise<PublishedBaremeCase[]> {
    return (await this.listVersions())
      .filter((v) => v.status === 'VALIDE_UAR')
      .flatMap((v) =>
        v.cases.map((c) => ({ versionId: v.id, versionLabel: v.label, validatedAt: v.validatedAt ?? '', code: c.code, label: c.label, partA: c.partA, partB: c.partB })),
      );
  }

  // ---- Catégories de véhicule -----------------------------------------------

  async listCategories(): Promise<VehicleCategoryView[]> {
    return withDegradedFallback(
      'BaremeReferentialService.listCategories',
      async () => (await this.categories.findAll({ orderBy: { code: 'ASC' } })).map(categoryView),
      () => [...this.memory.categories].sort((a, b) => a.code.localeCompare(b.code)),
    );
  }

  private async getCategory(code: string): Promise<VehicleCategoryView> {
    const c = (await this.listCategories()).find((x) => x.code === code);
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: `Catégorie de véhicule « ${code} » introuvable.` });
    return c;
  }

  async createCategory(dto: CreateVehicleCategoryDto, user: AuthenticatedUser): Promise<VehicleCategoryView> {
    if ((await this.listCategories()).some((c) => c.code === dto.code)) {
      throw new ConflictException({ code: 'CONFLICT', message: `La catégorie « ${dto.code} » existe déjà.` });
    }
    return withDegradedFallback(
      'BaremeReferentialService.createCategory',
      async () => {
        const e = this.categories.create({ code: dto.code, label: dto.label, status: 'SAISI', createdBy: user.id, createdAt: new Date() });
        await this.categories.getEntityManager().persistAndFlush(e);
        return categoryView(e);
      },
      () => {
        const view: VehicleCategoryView = { code: dto.code, label: dto.label, status: 'SAISI', createdBy: user.id, createdAt: new Date().toISOString() };
        this.memory.categories.push(view);
        return view;
      },
    );
  }

  /** Une modification fait repasser la catégorie en attente de validation UAR. */
  /** Décision PO (2026-10-19) : une catégorie validée est figée comme une version de barème — un dossier déjà codé ne doit pas voir son libellé changer. */
  async updateCategory(code: string, dto: UpdateVehicleCategoryDto, user: AuthenticatedUser): Promise<VehicleCategoryView> {
    const current = await this.getCategory(code);
    if (current.status === 'VALIDE_UAR') {
      throw new ConflictException({
        code: 'CATEGORIE_IMMUABLE',
        message: `La catégorie « ${current.code} » est validée UAR : elle ne se modifie plus, créez une nouvelle catégorie.`,
      });
    }
    return this.writeCategory(code, { label: dto.label, status: 'SAISI', updatedBy: user.id, validatedBy: null, validatedAt: null }, 'updateCategory');
  }

  async validateCategory(code: string, user: AuthenticatedUser): Promise<VehicleCategoryView> {
    const current = await this.getCategory(code);
    if (current.status === 'VALIDE_UAR') throw new ConflictException({ code: 'ALREADY_VALIDATED', message: 'Catégorie déjà validée par l’UAR.' });
    assertFourEyes(user, [current.createdBy, current.updatedBy]);
    return this.writeCategory(code, { status: 'VALIDE_UAR', validatedBy: user.id, validatedAt: new Date() }, 'validateCategory');
  }

  private writeCategory(
    code: string,
    patch: { label?: string; status: VehicleCategoryStatus; updatedBy?: string; validatedBy: string | null; validatedAt: Date | null },
    scope: string,
  ): Promise<VehicleCategoryView> {
    return withDegradedFallback(
      `BaremeReferentialService.${scope}`,
      async () => {
        const e = await this.categories.findOneOrFail({ code });
        this.categories.assign(e, patch as never);
        await this.categories.getEntityManager().flush();
        return categoryView(e);
      },
      () => {
        const row = this.memory.categories.find((c) => c.code === code);
        if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: `Catégorie « ${code} » introuvable (mode dégradé).` });
        const { validatedBy, validatedAt, ...rest } = patch;
        Object.assign(row, rest, { validatedBy: validatedBy ?? undefined, validatedAt: validatedAt?.toISOString() });
        return row;
      },
    );
  }

  async publishedCategories(): Promise<PublishedVehicleCategory[]> {
    return (await this.listCategories()).filter((c) => c.status === 'VALIDE_UAR').map((c) => ({ code: c.code, label: c.label }));
  }
}
