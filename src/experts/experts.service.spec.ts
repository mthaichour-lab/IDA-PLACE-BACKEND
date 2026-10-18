import { getRepositoryToken } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { Expert } from './entities/expert.entity';
import { ExpertsService } from './experts.service';

function throwingRepo() {
  return {
    findAndCount: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    findOne: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    findOneOrFail: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
  };
}

/** Acteur scopé compagnie — voir adherents.service.spec.ts. */
function correspondant(companyId: string): AuthenticatedUser {
  return { id: 'u', name: 'Correspondant (test)', email: 'c@test.dz', role: 'CORRESPONDANT_IDA', companyId, privileges: ['refedit'] };
}
function placeUser(): AuthenticatedUser {
  return { id: 'u2', name: 'Opérateur (test)', email: 'o@test.dz', role: 'OPERATEUR_PLACE', privileges: ['refedit'] };
}

/**
 * Revue sécurité 2026-10-18 (B.7) : un Expert sert PLUSIEURS compagnies à
 * la fois (`companies: string[]`), à la différence de Company/Agency —
 * `assertCompanyAmong` (expert.service.ts) vérifie que la compagnie de
 * l'appelant FIGURE PARMI la liste, pas une égalité stricte.
 */
describe('ExpertsService (mode dégradé) — scoping tenant multi-compagnies', () => {
  let service: ExpertsService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ExpertsService, { provide: getRepositoryToken(Expert), useFactory: throwingRepo }],
    }).compile();
    service = moduleRef.get(ExpertsService);
  });

  it("create refuse avec un 403 qu'un CORRESPONDANT_IDA crée un expert pour des compagnies qu'il ne représente pas", async () => {
    await expect(
      service.create({ name: 'Expert pirate', companies: ['SAA', 'CAAR'] }, correspondant('CAAT')),
    ).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
  });

  it('create autorise un CORRESPONDANT_IDA dont la compagnie figure parmi celles servies', async () => {
    const created = await service.create({ name: 'Expert légitime', companies: ['CAAT', 'SAA'] }, correspondant('CAAT'));
    expect(created.companies).toContain('CAAT');
  });

  it("create autorise toujours un rôle place, quelles que soient les compagnies listées", async () => {
    const created = await service.create({ name: 'Expert place', companies: ['TALA'] }, placeUser());
    expect(created.companies).toEqual(['TALA']);
  });

  it("update refuse avec un 403 qu'un CORRESPONDANT_IDA modifie un expert qui ne sert PAS sa compagnie (e-2 ne sert que CASH)", async () => {
    await expect(service.update('e-2', { name: 'Expert piraté' }, correspondant('CAAT'))).rejects.toMatchObject({
      response: { code: 'FORBIDDEN' },
    });
  });

  it('update autorise un CORRESPONDANT_IDA dont la compagnie figure déjà parmi celles servies par cet expert (e-1 sert CAAT et SAA)', async () => {
    const updated = await service.update('e-1', { name: 'Expert CAAT/SAA (MAJ)' }, correspondant('CAAT'));
    expect(updated.name).toBe('Expert CAAT/SAA (MAJ)');
  });
});
