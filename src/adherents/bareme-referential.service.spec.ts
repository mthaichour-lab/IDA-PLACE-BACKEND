import { EntityRepository } from '@mikro-orm/postgresql';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { Migration20261019010000_BaremeArt14 } from '../migrations/Migration20261019010000_BaremeArt14';
import { BaremeReferentialService } from './bareme-referential.service';
import { resolvePublishedBaremeCase } from './bareme-rules';

/** Repli mémoire forcé : toute opération base échoue (voir convention-referential.service.spec.ts). */
function throwingRepo<T extends object>(): EntityRepository<T> {
  const fail = jest.fn().mockRejectedValue(new Error('DB injoignable (test)'));
  return {
    findAll: fail,
    find: fail,
    findOne: fail,
    findOneOrFail: fail,
    create: jest.fn((d: unknown) => d),
    assign: jest.fn(),
    getEntityManager: jest.fn(() => ({ persist: jest.fn(), persistAndFlush: fail, flush: fail, removeAndFlush: fail })),
  } as unknown as EntityRepository<T>;
}

function user(id: string, role: AuthenticatedUser['role'] = 'OPERATEUR_PLACE'): AuthenticatedUser {
  return { id, name: id, email: `${id}@test.dz`, role, privileges: [] };
}

describe('BaremeReferentialService (mode dégradé, décision PO §5)', () => {
  let service: BaremeReferentialService;
  const operateur = user('op-1');
  const autreOperateur = user('op-2');
  const adminUar = user('uar-1', 'ADMIN_UAR');

  beforeEach(() => {
    service = new BaremeReferentialService(throwingRepo(), throwingRepo(), throwingRepo());
  });

  async function draftWithCase(author = operateur) {
    const v = await service.createVersion({ label: 'Barème 2026' }, author);
    await service.addCase(v.id, { code: 'B01', label: 'Cas 1', partA: 100, partB: 0 }, author);
    return v.id;
  }

  describe('rien de pré-rempli', () => {
    it('ni version, ni cas, ni catégorie au démarrage', async () => {
      expect(await service.listVersions()).toEqual([]);
      expect(await service.listCategories()).toEqual([]);
      expect(await service.publishedCases()).toEqual([]);
      expect(await service.publishedCategories()).toEqual([]);
    });

    it('la migration ne contient aucun insert (ni codes B01-B11, ni parts, ni catégories)', async () => {
      const sql: string[] = [];
      const migration = Object.create(Migration20261019010000_BaremeArt14.prototype) as Migration20261019010000_BaremeArt14;
      (migration as unknown as { addSql: (s: string) => void }).addSql = (s: string) => sql.push(s);
      await migration.up();
      const all = sql.join('\n');
      expect(all).not.toMatch(/insert\s+into/i);
      expect(all).not.toMatch(/update\s+"/i);
      expect(all).not.toMatch(/B0\d|B1\d/);
    });
  });

  describe('parts = 100', () => {
    it('refuse un cas dont partA + partB ≠ 100 (400), à l’ajout comme à la modification', async () => {
      const v = await service.createVersion({ label: 'v' }, operateur);
      await expect(service.addCase(v.id, { code: 'B01', label: 'x', partA: 60, partB: 30 }, operateur)).rejects.toMatchObject({ status: 400, response: { code: 'PARTS_INVALIDES' } });
      await service.addCase(v.id, { code: 'B01', label: 'x', partA: 75, partB: 25 }, operateur);
      await expect(service.updateCase(v.id, 'B01', { partA: 50 }, operateur)).rejects.toMatchObject({ status: 400 });
      await expect(service.updateCase(v.id, 'B01', { partA: 50, partB: 50 }, operateur)).resolves.toMatchObject({ cases: [expect.objectContaining({ partA: 50, partB: 50 })] });
    });

    it('refuse un code en double dans la même version (409)', async () => {
      const id = await draftWithCase();
      await expect(service.addCase(id, { code: 'B01', label: 'y', partA: 0, partB: 100 }, operateur)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('règle des quatre yeux', () => {
    it('409 quand l’auteur de la version tente de la valider', async () => {
      const id = await draftWithCase(adminUar);
      await expect(service.validateVersion(id, adminUar)).rejects.toMatchObject({ response: { code: 'FOUR_EYES' } });
    });

    it('409 quand le validateur a seulement saisi ou modifié un cas', async () => {
      const id = await draftWithCase(operateur);
      await service.updateCase(id, 'B01', { label: 'Libellé corrigé' }, adminUar);
      await expect(service.validateVersion(id, adminUar)).rejects.toMatchObject({ response: { code: 'FOUR_EYES' } });
    });

    it('409 quand le validateur a supprimé un cas de la version', async () => {
      const id = await draftWithCase(operateur);
      await service.addCase(id, { code: 'B02', label: 'x', partA: 0, partB: 100 }, operateur);
      await service.removeCase(id, 'B02', adminUar);
      await expect(service.validateVersion(id, adminUar)).rejects.toMatchObject({ response: { code: 'FOUR_EYES' } });
    });

    it('une autre personne valide : statut VALIDE_UAR, validatedBy renseigné', async () => {
      const id = await draftWithCase(operateur);
      await expect(service.validateVersion(id, adminUar)).resolves.toMatchObject({ status: 'VALIDE_UAR', validatedBy: 'uar-1' });
    });

    it('catégorie : 409 si l’auteur valide, validée par une autre personne', async () => {
      await service.createCategory({ code: 'VL', label: 'Véhicule léger' }, adminUar);
      await expect(service.validateCategory('VL', adminUar)).rejects.toMatchObject({ response: { code: 'FOUR_EYES' } });
      await service.updateCategory('VL', { label: 'VL' }, autreOperateur);
      await expect(service.validateCategory('VL', autreOperateur)).rejects.toMatchObject({ response: { code: 'FOUR_EYES' } });
      await expect(service.validateCategory('VL', user('uar-2', 'ADMIN_UAR'))).resolves.toMatchObject({ status: 'VALIDE_UAR' });
    });

    it('catégorie validée : figée (409 CATEGORIE_IMMUABLE), libellé inchangé', async () => {
      await service.createCategory({ code: 'PL', label: 'Poids lourd' }, operateur);
      await service.validateCategory('PL', adminUar);
      await expect(service.updateCategory('PL', { label: 'Autre' }, operateur)).rejects.toMatchObject({ response: { code: 'CATEGORIE_IMMUABLE' } });
      expect((await service.listCategories()).find((c) => c.code === 'PL')).toMatchObject({ label: 'Poids lourd', status: 'VALIDE_UAR' });
    });
  });

  describe('immuabilité d’une version validée', () => {
    it('ni la version ni ses cas ne se modifient plus (409 VERSION_IMMUABLE)', async () => {
      const id = await draftWithCase();
      await service.validateVersion(id, adminUar);
      const immuable = { response: { code: 'VERSION_IMMUABLE' } };
      await expect(service.updateVersion(id, { label: 'autre' }, operateur)).rejects.toMatchObject(immuable);
      await expect(service.addCase(id, { code: 'B02', label: 'x', partA: 50, partB: 50 }, operateur)).rejects.toMatchObject(immuable);
      await expect(service.updateCase(id, 'B01', { label: 'x' }, operateur)).rejects.toMatchObject(immuable);
      await expect(service.removeCase(id, 'B01', operateur)).rejects.toMatchObject(immuable);
      await expect(service.validateVersion(id, user('uar-2', 'ADMIN_UAR'))).rejects.toMatchObject({ response: { code: 'ALREADY_VALIDATED' } });
      expect((await service.getVersion(id)).cases).toEqual([expect.objectContaining({ code: 'B01', partA: 100, partB: 0 })]);
    });

    it('une version archivée reste immuable et sort du barème publié', async () => {
      const id = await draftWithCase();
      await service.validateVersion(id, adminUar);
      expect(await service.publishedCases()).toHaveLength(1);
      await service.archiveVersion(id, adminUar);
      expect(await service.publishedCases()).toEqual([]);
      await expect(service.addCase(id, { code: 'B02', label: 'x', partA: 50, partB: 50 }, operateur)).rejects.toMatchObject({ response: { code: 'VERSION_IMMUABLE' } });
      await expect(service.archiveVersion(id, adminUar)).rejects.toMatchObject({ status: 409 });
    });

    it('une version vide ne se valide pas (400)', async () => {
      const v = await service.createVersion({ label: 'vide' }, operateur);
      await expect(service.validateVersion(v.id, adminUar)).rejects.toMatchObject({ status: 400, response: { code: 'BAREME_VIDE' } });
    });
  });

  describe('barème publié', () => {
    it('un brouillon n’est jamais publié ; la version validée le plus récemment l’emporte, sauf version demandée', async () => {
      const v1 = await draftWithCase();
      expect(await service.publishedCases()).toEqual([]);
      await service.validateVersion(v1, adminUar);
      const v2 = await service.createVersion({ label: 'Barème 2027' }, operateur);
      await service.addCase(v2.id, { code: 'B01', label: 'Cas 1 révisé', partA: 50, partB: 50 }, operateur);
      await new Promise((r) => setTimeout(r, 5));
      await service.validateVersion(v2.id, adminUar);
      const cases = await service.publishedCases();
      expect(resolvePublishedBaremeCase(cases, 'b01')).toMatchObject({ versionId: v2.id, partA: 50 });
      expect(resolvePublishedBaremeCase(cases, 'B01', 'Barème 2026')).toMatchObject({ versionId: v1, partA: 100 });
      expect(resolvePublishedBaremeCase(cases, 'B09')).toBeUndefined();
    });
  });

  describe('SEC-30 — historique des auteurs et révision', () => {
    it('un Admin UAR ayant modifié la version ne peut pas la valider, même si un tiers l’a modifiée ensuite', async () => {
      const auteur = user('uar-auteur', 'ADMIN_UAR');
      const id = await draftWithCase();
      await service.updateVersion(id, { label: 'Barème 2026 (relu)' }, auteur);
      await service.updateVersion(id, { sourceRef: 'Note UAR' }, autreOperateur);
      await expect(service.validateVersion(id, auteur)).rejects.toMatchObject({ status: 409, response: { code: 'FOUR_EYES' } });
      await expect(service.validateVersion(id, adminUar)).resolves.toMatchObject({ status: 'VALIDE_UAR' });
    });

    it('toute saisie de cas incrémente la révision ; valider une révision périmée renvoie 409', async () => {
      const id = await draftWithCase();
      const lue = (await service.getVersion(id)).revision;
      await service.updateCase(id, 'B01', { partA: 70, partB: 30 }, autreOperateur);
      await expect(service.validateVersion(id, adminUar, lue)).rejects.toMatchObject({ status: 409, response: { code: 'REVISION_PERIMEE' } });
      await expect(service.validateVersion(id, adminUar, lue + 1)).resolves.toMatchObject({ status: 'VALIDE_UAR' });
    });
  });
});
