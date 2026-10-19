import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { LedgerService } from '../ledger/ledger.service';
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
import { assertExpectedRevision, assertFourEyes, withAuthor } from './referential-rules';

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
  /** SEC-30 : auteurs successifs (version ET cas) et révision courante. */
  authors?: string[];
  revision: number;
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
  authors?: string[];
  revision: number;
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
    authors: e.authors ?? undefined,
    revision: e.revision ?? 1,
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
    authors: e.authors ?? undefined,
    revision: e.revision ?? 1,
  };
}

function publicCase({ versionId: _versionId, ...rest }: StoredCase): BaremeCaseView {
  return rest;
}

/**
 * Barème Art. 14 et catégories de véhicule (décision PO §5). Rien n'est
 * pré-rempli : ni codes, ni parts, ni catégories. Contrôles métier et quatre
 * yeux toujours AVANT la closure de `withDegradedFallback`.
 *
 * SEC-30 : toute saisie (version, cas, catégorie) ajoute son auteur à
 * l'historique `authors` de la version/catégorie et incrémente sa révision ;
 * la validation exclut TOUS ces auteurs et peut viser une révision précise ;
 * chaque écriture est scellée au journal.
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
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  private async seal(type: string, ref: string, user: AuthenticatedUser, summary: Record<string, unknown>): Promise<void> {
    if (this.ledger) await this.ledger.append(type, ref, user.id, JSON.stringify(summary));
  }

  /** Auteurs connus d'une version : historique, plus créateur/dernier modificateur des lignes héritées. */
  private versionAuthors(v: BaremeVersionView): string[] {
    return [...new Set([v.createdBy, ...(v.updatedBy ? [v.updatedBy] : []), ...(v.authors ?? []), ...v.cases.flatMap((c) => [c.createdBy, ...(c.updatedBy ? [c.updatedBy] : [])])])];
  }

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
        const e = this.versions.create({ label, sourceRef: dto.sourceRef, status: 'BROUILLON', createdBy: user.id, createdAt: new Date(), authors: [user.id], revision: 1 });
        await this.versions.getEntityManager().persistAndFlush(e);
        return versionRow(e);
      },
      () => {
        const row: StoredVersion = { id: randomUUID(), label, sourceRef: dto.sourceRef, status: 'BROUILLON', createdBy: user.id, createdAt: new Date().toISOString(), authors: [user.id], revision: 1 };
        this.memory.versions.push(row);
        return row;
      },
    );
    await this.seal('BAREME_VERSION_CREEE', stored.id, user, { label });
    return { ...stored, cases: [] };
  }

  /** Toute saisie sur une version (libellé, cas) l'ajoute à ses auteurs et incrémente sa révision. */
  private async touchVersion(v: BaremeVersionView, user: AuthenticatedUser, extra: { label?: string; sourceRef?: string } = {}, scope: string): Promise<void> {
    await this.writeVersion(v.id, { ...extra, updatedBy: user.id, authors: withAuthor(this.versionAuthors(v), user.id), revision: v.revision + 1 }, scope);
  }

  async updateVersion(id: string, dto: UpdateBaremeVersionDto, user: AuthenticatedUser): Promise<BaremeVersionView> {
    const v = await this.getDraft(id);
    const label = dto.label?.trim();
    if (label) await this.assertLabelFree(label, id);
    await this.touchVersion(v, user, { ...(label ? { label } : {}), ...(dto.sourceRef !== undefined ? { sourceRef: dto.sourceRef } : {}) }, 'updateVersion');
    await this.seal('BAREME_VERSION_MODIFIEE', id, user, { label: label ?? v.label, sourceRef: dto.sourceRef });
    return this.getVersion(id);
  }

  /** Quatre yeux : le validateur n'a ni créé ni modifié la version, ni aucun de ses cas (historique complet, SEC-30). */
  async validateVersion(id: string, user: AuthenticatedUser, expectedRevision?: number): Promise<BaremeVersionView> {
    const v = await this.getVersion(id);
    if (v.status !== 'BROUILLON') {
      throw new ConflictException({ code: 'ALREADY_VALIDATED', message: `Seule une version BROUILLON peut être validée (statut actuel : ${v.status}).` });
    }
    if (v.cases.length === 0) throw new BadRequestException({ code: 'BAREME_VIDE', message: 'Une version sans aucun cas ne peut pas être validée.' });
    for (const c of v.cases) assertBaremeParts(c.partA, c.partB);
    assertExpectedRevision(v.revision, expectedRevision);
    assertFourEyes(user, this.versionAuthors(v));
    await this.writeVersion(id, { status: 'VALIDE_UAR', validatedBy: user.id, validatedAt: new Date() }, 'validateVersion');
    await this.seal('BAREME_VERSION_VALIDEE', id, user, { label: v.label, revision: v.revision, authors: this.versionAuthors(v), cases: v.cases.map((c) => ({ code: c.code, partA: c.partA, partB: c.partB })) });
    return this.getVersion(id);
  }

  async archiveVersion(id: string, user: AuthenticatedUser): Promise<BaremeVersionView> {
    const v = await this.getVersion(id);
    if (v.status !== 'VALIDE_UAR') {
      throw new ConflictException({ code: 'CONFLICT', message: `Seule une version VALIDE_UAR peut être archivée (statut actuel : ${v.status}).` });
    }
    await this.writeVersion(id, { status: 'ARCHIVE' }, 'archiveVersion');
    await this.seal('BAREME_VERSION_ARCHIVEE', id, user, { label: v.label });
    return this.getVersion(id);
  }

  private writeVersion(
    id: string,
    patch: { label?: string; sourceRef?: string; status?: BaremeVersionStatus; updatedBy?: string; validatedBy?: string; validatedAt?: Date; authors?: string[]; revision?: number },
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
    await this.touchVersion(v, user, {}, 'addCase');
    await this.seal('BAREME_CAS_AJOUTE', versionId, user, { code: dto.code, partA: dto.partA, partB: dto.partB });
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
    await this.touchVersion(v, user, {}, 'updateCase');
    await this.seal('BAREME_CAS_MODIFIE', versionId, user, { code, before: { partA: current.partA, partB: current.partB }, after: { partA: dto.partA ?? current.partA, partB: dto.partB ?? current.partB } });
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
    await this.touchVersion(v, user, {}, 'removeCase');
    await this.seal('BAREME_CAS_SUPPRIME', versionId, user, { code });
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
        const e = this.categories.create({ code: dto.code, label: dto.label, status: 'SAISI', createdBy: user.id, createdAt: new Date(), authors: [user.id], revision: 1 });
        await this.categories.getEntityManager().persistAndFlush(e);
        return categoryView(e);
      },
      () => {
        const view: VehicleCategoryView = { code: dto.code, label: dto.label, status: 'SAISI', createdBy: user.id, createdAt: new Date().toISOString(), authors: [user.id], revision: 1 };
        this.memory.categories.push(view);
        return view;
      },
    ).then(async (created) => {
      await this.seal('CATEGORIE_VEHICULE_SAISIE', created.code, user, { label: created.label });
      return created;
    });
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
    const updated = await this.writeCategory(
      code,
      {
        label: dto.label,
        status: 'SAISI',
        updatedBy: user.id,
        validatedBy: null,
        validatedAt: null,
        authors: withAuthor(current.authors ?? [current.createdBy, ...(current.updatedBy ? [current.updatedBy] : [])], user.id),
        revision: current.revision + 1,
      },
      'updateCategory',
    );
    await this.seal('CATEGORIE_VEHICULE_MODIFIEE', code, user, { before: current.label, after: dto.label, revision: updated.revision });
    return updated;
  }

  async validateCategory(code: string, user: AuthenticatedUser, expectedRevision?: number): Promise<VehicleCategoryView> {
    const current = await this.getCategory(code);
    if (current.status === 'VALIDE_UAR') throw new ConflictException({ code: 'ALREADY_VALIDATED', message: 'Catégorie déjà validée par l’UAR.' });
    assertExpectedRevision(current.revision, expectedRevision);
    assertFourEyes(user, [current.createdBy, current.updatedBy, ...(current.authors ?? [])]);
    const validated = await this.writeCategory(code, { status: 'VALIDE_UAR', validatedBy: user.id, validatedAt: new Date() }, 'validateCategory');
    await this.seal('CATEGORIE_VEHICULE_VALIDEE', code, user, { label: current.label, revision: current.revision, authors: current.authors ?? [current.createdBy] });
    return validated;
  }

  private writeCategory(
    code: string,
    patch: { label?: string; status: VehicleCategoryStatus; updatedBy?: string; validatedBy: string | null; validatedAt: Date | null; authors?: string[]; revision?: number },
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
