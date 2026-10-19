import { getRepositoryToken } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { AdherentsService } from '../adherents/adherents.service';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { EligibilityService } from '../eligibility/eligibility.service';
import { MatchingService } from '../matching/matching.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import { RecoursService } from '../recours/recours.service';
import { ClaimsService } from './claims.service';
import { ClaimViewDto } from './dto/claim.dto';
import { Claim } from './entities/claim.entity';

/**
 * `ClaimsService.openRecours` (POST /recours) — SEC-06 : le montant d'un
 * recours est borné par celui du dossier (expertisé, sinon estimé). Le
 * dossier est fourni par un `get` simulé ; le reste du service n'est pas
 * sollicité.
 */
describe('ClaimsService.openRecours — SEC-06 (montant borné par le dossier)', () => {
  const operateur: AuthenticatedUser = { id: 'op', name: 'Opérateur', email: 'op@test.dz', role: 'OPERATEUR_PLACE', privileges: ['insert'] };
  let service: ClaimsService;
  let recoursCreate: jest.Mock;

  const claim = (overrides: Partial<ClaimViewDto>): ClaimViewDto =>
    ({
      id: 'clm-1',
      numEconstat: 'E-1',
      company: 'CAAT',
      counterpartyCompany: 'SAA',
      accidentDate: '2026-09-01',
      wilaya: '16',
      estimatedAmount: 150_000,
      expertAmount: undefined,
      state: 'A_APPARIER',
      createdAt: '2026-09-02T00:00:00.000Z',
      eligibilityVerdict: 'ELIGIBLE_IDA',
      eligibilityReasons: [],
      ...overrides,
    }) as ClaimViewDto;

  beforeEach(async () => {
    recoursCreate = jest.fn(async (dto) => ({ id: 'r-1', ...dto }));
    const moduleRef = await Test.createTestingModule({
      providers: [
        ClaimsService,
        { provide: getRepositoryToken(Claim), useValue: {} },
        { provide: EligibilityService, useValue: {} },
        { provide: MatchingService, useValue: {} },
        { provide: RealtimeGateway, useValue: { emitEvent: jest.fn() } },
        { provide: RecoursService, useValue: { listAll: jest.fn(async () => []), create: recoursCreate } },
        { provide: AdherentsService, useValue: { assertCompanyActiveFor: jest.fn(async () => undefined) } },
      ],
    }).compile();
    service = moduleRef.get(ClaimsService);
  });

  it('refuse un montant supérieur au montant ESTIMÉ quand il n’y a pas d’expertise (400 RECOURS_MONTANT_SUPERIEUR_DOSSIER)', async () => {
    jest.spyOn(service, 'get').mockResolvedValue(claim({ estimatedAmount: 150_000 }));
    await expect(service.openRecours({ claimId: 'clm-1', from: 'CAAT', to: 'SAA', amount: 150_000.01 }, operateur)).rejects.toMatchObject({
      status: 400,
      response: { code: 'RECOURS_MONTANT_SUPERIEUR_DOSSIER' },
    });
    expect(recoursCreate).not.toHaveBeenCalled();
    await expect(service.openRecours({ claimId: 'clm-1', from: 'CAAT', to: 'SAA', amount: 150_000 }, operateur)).resolves.toMatchObject({ id: 'r-1' });
  });

  it('le montant EXPERTISÉ prime sur l’estimé (même s’il est inférieur)', async () => {
    jest.spyOn(service, 'get').mockResolvedValue(claim({ estimatedAmount: 150_000, expertAmount: 90_000 }));
    await expect(service.openRecours({ claimId: 'clm-1', from: 'CAAT', to: 'SAA', amount: 100_000 }, operateur)).rejects.toMatchObject({ response: { code: 'RECOURS_MONTANT_SUPERIEUR_DOSSIER' } });
    await expect(service.openRecours({ claimId: 'clm-1', from: 'CAAT', to: 'SAA', amount: 90_000 }, operateur)).resolves.toBeDefined();
  });

  it('refuse un recours sur un dossier sans montant (400 MONTANT_DOSSIER_INCONNU)', async () => {
    jest.spyOn(service, 'get').mockResolvedValue(claim({ estimatedAmount: 0, expertAmount: undefined }));
    await expect(service.openRecours({ claimId: 'clm-1', from: 'CAAT', to: 'SAA', amount: 1 }, operateur)).rejects.toMatchObject({ response: { code: 'MONTANT_DOSSIER_INCONNU' } });
  });

  it('le scénario d’exploitation (1 000 milliards DZD sur un dossier de 150 000 DA) est refusé avant toute création', async () => {
    jest.spyOn(service, 'get').mockResolvedValue(claim({}));
    await expect(service.openRecours({ claimId: 'clm-1', from: 'CAAT', to: 'SAA', amount: 1e12 }, operateur)).rejects.toMatchObject({ status: 400 });
    expect(recoursCreate).not.toHaveBeenCalled();
  });
});
