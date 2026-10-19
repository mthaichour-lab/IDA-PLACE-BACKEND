import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'crypto';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { LedgerService } from '../ledger/ledger.service';
import { Expert } from './entities/expert.entity';
import { ExpertsService } from './experts.service';
import { decryptRib, encryptRib, parseRibKey } from './rib-cipher';
import { simulatedDatabaseOutage } from '../common/database/db-errors';

const EXPERT_CAAT_SAA = '3b6f2c1e-0c1a-4a7e-8e01-0000000000e1';
const EXPERT_CASH = '3b6f2c1e-0c1a-4a7e-8e01-0000000000e2';

function throwingRepo() {
  const fail = () => Promise.reject(simulatedDatabaseOutage());
  return {
    findAndCount: jest.fn(fail),
    findOne: jest.fn(fail),
    findOneOrFail: jest.fn(fail),
    create: jest.fn((d: unknown) => d),
    getEntityManager: jest.fn(() => ({ persistAndFlush: jest.fn(fail), flush: jest.fn(fail) })),
  };
}

function correspondant(companyId: string): AuthenticatedUser {
  return { id: `u-${companyId}`, name: 'Correspondant (test)', email: 'c@test.dz', role: 'CORRESPONDANT_IDA', companyId, privileges: ['refedit'] };
}
function placeUser(): AuthenticatedUser {
  return { id: 'u2', name: 'Opérateur (test)', email: 'o@test.dz', role: 'OPERATEUR_PLACE', privileges: ['refedit'] };
}

/**
 * Un Expert sert PLUSIEURS compagnies à la fois (`companies: string[]`).
 * SEC-14 : une compagnie ne gère que SON rattachement ; le statut global et
 * la fiche d'un expert partagé relèvent de la place.
 */
describe('ExpertsService (mode dégradé) — expert partagé entre compagnies', () => {
  let service: ExpertsService;
  let ledgerAppend: jest.Mock;

  async function build(config: Record<string, string> = {}) {
    ledgerAppend = jest.fn(async () => ({}));
    const moduleRef = await Test.createTestingModule({
      providers: [
        ExpertsService,
        { provide: getRepositoryToken(Expert), useFactory: throwingRepo },
        { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
        { provide: LedgerService, useValue: { append: ledgerAppend } },
      ],
    }).compile();
    return moduleRef.get(ExpertsService);
  }

  beforeEach(async () => {
    service = await build();
  });

  it("create refuse avec un 403 qu'une compagnie rattache d'office des concurrentes", async () => {
    await expect(service.create({ name: 'Expert pirate', companies: ['SAA', 'CAAR'] }, correspondant('CAAT'))).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
    await expect(service.create({ name: 'Expert pirate 2', companies: ['CAAT', 'SAA'] }, correspondant('CAAT'))).rejects.toMatchObject({ status: 403 });
  });

  it('create autorise une compagnie à créer un expert rattaché à elle seule', async () => {
    const created = await service.create({ name: 'Expert CAAT', companies: ['CAAT'] }, correspondant('CAAT'));
    expect(created.companies).toEqual(['CAAT']);
    expect(ledgerAppend).toHaveBeenCalledWith('EXPERT_CREE', created.id, 'u-CAAT', expect.any(String));
  });

  it('create autorise toujours un rôle place, quelles que soient les compagnies listées', async () => {
    const created = await service.create({ name: 'Expert place', companies: ['TALA', 'SAA'] }, placeUser());
    expect(created.companies).toEqual(['TALA', 'SAA']);
  });

  describe('SEC-14', () => {
    it('une compagnie ne peut pas modifier le statut global d’un expert partagé (403)', async () => {
      await expect(service.update(EXPERT_CAAT_SAA, { status: 'SUSPENDU' as never }, correspondant('CAAT'))).rejects.toMatchObject({ status: 403 });
    });

    it('une compagnie ne peut pas retirer ou ajouter une AUTRE compagnie (403)', async () => {
      await expect(service.update(EXPERT_CAAT_SAA, { companies: ['CAAT'] }, correspondant('CAAT'))).rejects.toMatchObject({ status: 403 }); // retire SAA
      await expect(service.update(EXPERT_CAAT_SAA, { companies: ['CAAT', 'SAA', 'CASH'] }, correspondant('CAAT'))).rejects.toMatchObject({ status: 403 }); // ajoute CASH
    });

    it('une compagnie peut retirer son propre rattachement', async () => {
      const shared = await service.create({ name: 'Expert partagé', companies: ['CAAT', 'SAA'] }, placeUser());
      const updated = await service.update(shared.id, { companies: ['SAA'] }, correspondant('CAAT'));
      expect(updated.companies).toEqual([]); // projection : CAAT n'y figure plus, SAA n'est jamais exposée à CAAT
      expect(ledgerAppend).toHaveBeenCalledWith('EXPERT_MODIFIE', shared.id, 'u-CAAT', expect.stringContaining('"companiesBefore":["CAAT","SAA"]'));
    });

    it('la fiche d’un expert partagé n’est modifiable que par la place (403 pour une compagnie)', async () => {
      await expect(service.update(EXPERT_CAAT_SAA, { name: 'Expert renommé' }, correspondant('CAAT'))).rejects.toMatchObject({ status: 403 });
      const updated = await service.update(EXPERT_CAAT_SAA, { name: 'Expert CAAT/SAA (MAJ place)', status: 'ACTIF' as never }, placeUser());
      expect(updated.name).toBe('Expert CAAT/SAA (MAJ place)');
    });

    it('un expert qui ne sert pas la compagnie lui est invisible (404)', async () => {
      await expect(service.update(EXPERT_CASH, { name: 'Expert piraté' }, correspondant('CAAT'))).rejects.toMatchObject({ status: 404 });
    });

    it('un expert servant uniquement la compagnie reste modifiable par elle', async () => {
      const own = await service.create({ name: 'Expert interne', companies: ['ALLI'] }, correspondant('ALLI'));
      await expect(service.update(own.id, { firm: 'Cabinet ALLI' }, correspondant('ALLI'))).resolves.toMatchObject({ firm: 'Cabinet ALLI' });
    });
  });

  describe('SEC-26 — lecture', () => {
    it('une compagnie ne liste que les experts qui la servent, sans la liste des autres compagnies servies', async () => {
      const list = await service.list(1, 50, correspondant('SAA'));
      expect(list.items.length).toBeGreaterThan(0);
      expect(list.items.every((e) => e.companies.length === 1 && e.companies[0] === 'SAA')).toBe(true);
      expect(list.items.find((e) => e.id === EXPERT_CASH)).toBeUndefined();
      const forPlace = await service.list(1, 50, placeUser());
      expect(forPlace.items.find((e) => e.id === EXPERT_CAAT_SAA)?.companies).toEqual(expect.arrayContaining(['CAAT', 'SAA']));
    });
  });

  describe('SEC-49 — RIB chiffré', () => {
    it('sans clé configurée, un RIB est refusé plutôt que stocké en clair (400 RIB_NON_CHIFFRABLE)', async () => {
      await expect(service.create({ name: 'Expert RIB', companies: ['CAAT'], rib: '00799999000123456789' }, placeUser())).rejects.toMatchObject({ status: 400, response: { code: 'RIB_NON_CHIFFRABLE' } });
    });

    it('avec une clé, le RIB est accepté et seul son masque est exposé aux rôles place', async () => {
      const keyed = await build({ EXPERT_RIB_KEY: randomBytes(32).toString('base64') });
      const created = await keyed.create({ name: 'Expert RIB', companies: ['CAAT'], rib: '00799999000123456789' }, placeUser());
      expect(created).toMatchObject({ ribMasked: '••••6789' });
      expect(JSON.stringify(created)).not.toContain('00799999000123456789');
    });

    it('chiffrement AES-256-GCM : aller-retour, enveloppe non lisible, falsification détectée', () => {
      const key = randomBytes(32);
      const envelope = encryptRib('00799999000123456789', key);
      expect(envelope.startsWith('v1:')).toBe(true);
      expect(envelope).not.toContain('00799999000123456789');
      expect(decryptRib(envelope, key)).toBe('00799999000123456789');
      const tampered = envelope.slice(0, -2) + (envelope.endsWith('A') ? 'B' : 'A') + '=';
      expect(() => decryptRib(tampered, key)).toThrow();
      expect(() => parseRibKey('trop-courte')).toThrow(/32 octets/);
    });
  });
});
