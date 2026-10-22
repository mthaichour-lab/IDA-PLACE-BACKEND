import 'reflect-metadata';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { UpdatePlaceUserDto } from '../../admin/dto/place-user.dto';
import { PlaceUserDirectory } from './place-user-directory.service';
import { simulatedDatabaseOutage } from '../database/db-errors';
import { PlaceUser } from './place-user.entity';

/** Repli mémoire forcé — voir adherents.service.spec.ts pour le même principe. */
function throwingRepo() {
  return {
    create: jest.fn((data: unknown) => data),
    findOne: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    findAndCount: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    getEntityManager: jest.fn(() => ({
      persistAndFlush: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
      flush: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    })),
  };
}

describe('PlaceUserDirectory (mode dégradé)', () => {
  let service: PlaceUserDirectory;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PlaceUserDirectory, { provide: getRepositoryToken(PlaceUser), useFactory: throwingRepo }],
    }).compile();
    service = moduleRef.get(PlaceUserDirectory);
  });

  it('crée un utilisateur et le retrouve en liste (repli mémoire)', async () => {
    const created = await service.create({ name: 'Nadia', email: 'nadia@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'COMP-0001' });
    const list = await service.list(1, 6);
    expect(list.items.some((u) => u.id === created.id && u.name === 'Nadia')).toBe(true);
  });

  /**
   * Régression — bug trouvé et corrigé au sprint où `UsersService` (devenu
   * `PlaceUserDirectory`) a été introduit (voir `definedFieldsOnly`) : avec
   * `target: ES2022` (voir tsconfig.json), `class-transformer` (le
   * `ValidationPipe({transform: true})` global de l'app) instancie
   * `UpdatePlaceUserDto` avec TOUTES ses propriétés de classe comme propres
   * (valant `undefined` si non fournies) — PAS seulement celles du JSON
   * reçu. Un `Object.assign`/`repo.assign` naïf sur ce DTO écrase alors
   * silencieusement les champs non fournis. Ce test reproduit EXACTEMENT ce
   * que fait `ValidationPipe` (`plainToInstance`) plutôt qu'un objet
   * littéral, pour que toute régression soit détectée.
   */
  it('une mise à jour partielle (ex. {active:false}) ne doit JAMAIS effacer les autres champs', async () => {
    const created = await service.create({ name: 'Nadia', email: 'nadia2@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'COMP-0001', grant: ['bill'] });

    const dto = plainToInstance(UpdatePlaceUserDto, { active: false }); // reproduit class-transformer, pas un objet littéral
    const updated = await service.update(created.id, dto);

    expect(updated.active).toBe(false);
    expect(updated.name).toBe('Nadia');
    expect(updated.email).toBe('nadia2@caat.dz');
    expect(updated.role).toBe('CORRESPONDANT_IDA');
    expect(updated.companyId).toBe('COMP-0001');
    expect(updated.grant).toEqual(['bill']);
  });

  it('refuse un compte de la place rattaché à une compagnie (séparation place / compagnies)', async () => {
    await expect(service.create({ name: 'Op', email: 'op-cash@finlab.dz', role: 'OPERATEUR_PLACE', companyId: 'CASH' })).rejects.toMatchObject({
      response: { code: 'COMPTE_PLACE_AVEC_COMPAGNIE' },
    });
  });

  it('un correspondant promu rôle de la place perd son rattachement compagnie', async () => {
    const created = await service.create({ name: 'Promu', email: 'promu@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'CAAT' });
    const updated = await service.update(created.id, { role: 'OPERATEUR_PLACE' });
    expect(updated.role).toBe('OPERATEUR_PLACE');
    expect(updated.companyId).toBeUndefined();
  });

  it('filtre la liste par périmètre : comptes de la place / comptes des compagnies', async () => {
    const place = await service.list(1, 100, 'PLACE');
    const companies = await service.list(1, 100, 'COMPAGNIE');
    expect(place.items.every((u) => !u.companyId && !['CORRESPONDANT_IDA', 'TRESORIER'].includes(u.role))).toBe(true);
    expect(companies.items.every((u) => !!u.companyId && ['CORRESPONDANT_IDA', 'TRESORIER'].includes(u.role))).toBe(true);
    expect(place.total + companies.total).toBe((await service.list(1, 100)).total);
  });

  it('404 normalisé si id inconnu', async () => {
    await expect(service.update('id-inconnu', plainToInstance(UpdatePlaceUserDto, { active: false }))).rejects.toThrow();
  });

  describe('lookupAccount — consommé par KeycloakStrategy (SEC-09/SEC-24)', () => {
    it('ACTIVE avec les dérogations grant/revoke d’un utilisateur actif (e-mail vérifié)', async () => {
      await service.create({ name: 'Yacine', email: 'yacine@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'CAAT', grant: ['bill'], revoke: ['synth'] });
      const result = await service.lookupAccount({ sub: 'kc-yacine', email: 'yacine@caat.dz', emailVerified: true });
      expect(result).toMatchObject({ status: 'ACTIVE', grant: ['bill'], revoke: ['synth'] });
    });

    it('INACTIVE pour un utilisateur suspendu (active:false) — distingué de « inconnu »', async () => {
      const created = await service.create({ name: 'Samia', email: 'samia@saa.dz', role: 'TRESORIER', companyId: 'SAA' });
      await service.update(created.id, plainToInstance(UpdatePlaceUserDto, { active: false }));
      const result = await service.lookupAccount({ sub: 'kc-samia', email: 'samia@saa.dz', emailVerified: true });
      expect(result).toEqual({ status: 'INACTIVE', userId: created.id });
    });

    it('UNKNOWN si aucun PlaceUser ne correspond (miroir non synchronisé)', async () => {
      const result = await service.lookupAccount({ sub: 'kc-x', email: 'inconnu@ailleurs.dz', emailVerified: true });
      expect(result).toEqual({ status: 'UNKNOWN' });
    });

    it('UNKNOWN si l’e-mail n’est pas vérifié : jamais de liaison par e-mail non vérifié', async () => {
      await service.create({ name: 'Karim', email: 'karim@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'CAAT' });
      const result = await service.lookupAccount({ sub: 'kc-karim', email: 'karim@caat.dz', emailVerified: false });
      expect(result).toEqual({ status: 'UNKNOWN' });
    });

    it('lie le compte au premier sub vérifié, puis refuse un autre sub présentant le même e-mail', async () => {
      await service.create({ name: 'Lina', email: 'lina@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'CAAT' });
      expect((await service.lookupAccount({ sub: 'kc-lina', email: 'lina@caat.dz', emailVerified: true })).status).toBe('ACTIVE');
      // Liaison par sub : retrouvé même si l'e-mail du jeton change.
      expect((await service.lookupAccount({ sub: 'kc-lina', email: 'autre@caat.dz', emailVerified: true })).status).toBe('ACTIVE');
      expect((await service.lookupAccount({ sub: 'kc-imposteur', email: 'lina@caat.dz', emailVerified: true })).status).toBe('SUB_MISMATCH');
    });
  });

  describe('plancher de privilèges (SEC-25)', () => {
    it('refuse un grant réservé à la place pour un rôle compagnie (création)', async () => {
      await expect(
        service.create({ name: 'X', email: 'x@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'CAAT', grant: ['decide'] }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('refuse un grant réservé à la place pour un rôle compagnie (mise à jour)', async () => {
      const created = await service.create({ name: 'Y', email: 'y@caat.dz', role: 'TRESORIER', companyId: 'CAAT' });
      await expect(service.update(created.id, plainToInstance(UpdatePlaceUserDto, { grant: ['closeQuarter'] }))).rejects.toMatchObject({ status: 400 });
    });

    it('refuse de passer en rôle compagnie un utilisateur qui détient un grant réservé', async () => {
      const created = await service.create({ name: 'Z', email: 'z@finlab.dz', role: 'OPERATEUR_PLACE', grant: ['decide'] });
      await expect(
        service.update(created.id, plainToInstance(UpdatePlaceUserDto, { role: 'CORRESPONDANT_IDA', companyId: 'CAAT' })),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('exige companyId pour un rôle compagnie', async () => {
      await expect(service.create({ name: 'W', email: 'w@caat.dz', role: 'TRESORIER' })).rejects.toMatchObject({ status: 400 });
    });
  });
});

/**
 * SEC-08 — une `ConflictException` levée DANS l'opération base (e-mail déjà
 * utilisé) doit remonter en 409 : AVANT, le `catch` générique du mode dégradé
 * l'interceptait et créait l'utilisateur en mémoire (201).
 */
describe('PlaceUserDirectory (base disponible) — SEC-08', () => {
  async function serviceWith(repo: unknown): Promise<PlaceUserDirectory> {
    const moduleRef = await Test.createTestingModule({
      providers: [PlaceUserDirectory, { provide: getRepositoryToken(PlaceUser), useValue: repo }],
    }).compile();
    return moduleRef.get(PlaceUserDirectory);
  }

  it('create : e-mail déjà présent en base → ConflictException, jamais de création en mémoire', async () => {
    const persistAndFlush = jest.fn();
    const service = await serviceWith({
      create: jest.fn((data: unknown) => data),
      findOne: jest.fn().mockResolvedValue({ id: 'existing', email: 'dup@caat.dz' }),
      getEntityManager: jest.fn(() => ({ persistAndFlush, flush: jest.fn() })),
    });

    await expect(service.create({ name: 'Dup', email: 'dup@caat.dz', role: 'OPERATEUR_PLACE' })).rejects.toBeInstanceOf(ConflictException);
    expect(persistAndFlush).not.toHaveBeenCalled();
    // Le repli mémoire n'a rien créé : la liste mémoire ne contient pas l'utilisateur.
  });

  it('create : violation d’unicité concurrente en base → remonte (409 par le filtre), pas de repli', async () => {
    const service = await serviceWith({
      create: jest.fn((data: unknown) => data),
      findOne: jest.fn().mockResolvedValue(null),
      getEntityManager: jest.fn(() => ({ persistAndFlush: jest.fn().mockRejectedValue(new UniqueConstraintViolationException(new Error('duplicate key'))) })),
    });

    await expect(service.create({ name: 'Race', email: 'race@caat.dz', role: 'OPERATEUR_PLACE' })).rejects.toBeInstanceOf(UniqueConstraintViolationException);
  });
});
