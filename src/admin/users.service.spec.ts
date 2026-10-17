import 'reflect-metadata';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { UpdatePlaceUserDto } from './dto/place-user.dto';
import { PlaceUser } from './entities/place-user.entity';
import { UsersService } from './users.service';

/** Repli mémoire forcé — voir adherents.service.spec.ts pour le même principe. */
function throwingRepo() {
  return {
    create: jest.fn((data: unknown) => data),
    findOne: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    findAndCount: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    getEntityManager: jest.fn(() => ({
      persistAndFlush: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
      flush: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    })),
  };
}

describe('UsersService (mode dégradé)', () => {
  let service: UsersService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, { provide: getRepositoryToken(PlaceUser), useFactory: throwingRepo }],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  it('crée un utilisateur et le retrouve en liste (repli mémoire)', async () => {
    const created = await service.create({ name: 'Nadia', email: 'nadia@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'COMP-0001' });
    const list = await service.list(1, 6);
    expect(list.items.some((u) => u.id === created.id && u.name === 'Nadia')).toBe(true);
  });

  /**
   * Régression — bug trouvé et corrigé pendant ce sprint (voir
   * users.service.ts, `definedFieldsOnly`) : avec `target: ES2022` (voir
   * tsconfig.json), `class-transformer` (le `ValidationPipe({transform:
   * true})` global de l'app) instancie `UpdatePlaceUserDto` avec TOUTES ses
   * propriétés de classe comme propres (valant `undefined` si non fournies)
   * — PAS seulement celles du JSON reçu. Un `Object.assign`/`repo.assign`
   * naïf sur ce DTO écrase alors silencieusement les champs non fournis.
   * Ce test reproduit EXACTEMENT ce que fait `ValidationPipe` (`plainToInstance`)
   * plutôt qu'un objet littéral, pour que toute régression soit détectée.
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

  it('404 normalisé si id inconnu', async () => {
    await expect(service.update('id-inconnu', plainToInstance(UpdatePlaceUserDto, { active: false }))).rejects.toThrow();
  });
});
