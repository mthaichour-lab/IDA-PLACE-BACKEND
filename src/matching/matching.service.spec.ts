import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AdherentsService } from '../adherents/adherents.service';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { RealtimeGateway } from '../realtime/realtime.module';
import { MatchQueueItem } from './entities/match-queue-item.entity';
import { MatchingService } from './matching.service';
import { ClaimMatchInput } from './matching.types';

/** Repli mémoire forcé : toute opération dépendant de la base échoue. */
function throwingRepo() {
  const fail = jest.fn().mockRejectedValue(new Error('DB injoignable (test)'));
  return {
    create: jest.fn((d: unknown) => d),
    find: fail,
    findOne: fail,
    findAll: fail,
    getEntityManager: jest.fn(() => ({ persist: jest.fn(), flush: fail, persistAndFlush: fail })),
  };
}

const operateur: AuthenticatedUser = { id: 'op', name: 'Opérateur', email: 'op@test.local', role: 'OPERATEUR_PLACE', privileges: ['matchDecide'] };
const tiers: AuthenticatedUser = { id: 'cash', name: 'Correspondant CASH', email: 'cash@test.local', role: 'CORRESPONDANT_IDA', companyId: 'CASH', privileges: ['matchDecide'] };

const declA: ClaimMatchInput = { id: 'clm-a', numEconstat: 'EC-1', company: 'CAAT', counterpartyCompany: 'SAA', plateA: '111', plateB: '222', accidentDate: '2026-10-01' };
const declB: ClaimMatchInput = { id: 'clm-b', numEconstat: 'EC-1', company: 'SAA', counterpartyCompany: 'CAAT', plateA: '222', plateB: '111', accidentDate: '2026-10-01' };

describe('MatchingService — décision sur une paire (mode dégradé)', () => {
  let service: MatchingService;
  let realtime: { emitEvent: jest.Mock };

  beforeEach(async () => {
    realtime = { emitEvent: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MatchingService,
        { provide: getRepositoryToken(MatchQueueItem), useFactory: throwingRepo },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: RealtimeGateway, useValue: realtime },
        { provide: AdherentsService, useValue: { publishedBaremeCases: async () => [] } },
      ],
    }).compile();
    service = moduleRef.get(MatchingService);
    await service.ingestClaim(declA, [declA]);
    await service.ingestClaim(declB, [declA, declB]);
  });

  async function rows() {
    const { items } = await service.queue({ page: 1, pageSize: 100 } as never);
    const ab = items.find((i) => i.refA === 'EC-1' && i.companyA === 'CAAT')!;
    const ba = items.find((i) => i.refA === 'EC-1' && i.companyA === 'SAA')!;
    return { ab, ba };
  }

  it('la paire existe dans les deux sens (une ligne par déclaration)', async () => {
    const { ab, ba } = await rows();
    expect(ab.companyB).toBe('SAA');
    expect(ba.companyB).toBe('CAAT');
  });

  it('confirmer une ligne confirme aussi la ligne miroir, avec un événement temps réel pour chacune', async () => {
    const { ab } = await rows();
    realtime.emitEvent.mockClear();
    await service.decide(ab.id, { action: 'confirm' }, 'Opérateur', operateur);
    const after = await rows();
    expect(after.ab.status).toBe('CONFIRME_MANUEL');
    expect(after.ba).toMatchObject({ status: 'CONFIRME_MANUEL', confirmedBy: 'Opérateur' });
    expect(realtime.emitEvent).toHaveBeenCalledTimes(2);
  });

  it('rejeter propage le rejet et son motif', async () => {
    const { ba } = await rows();
    await service.decide(ba.id, { action: 'reject', reason: 'Pas le même sinistre' }, 'Opérateur', operateur);
    expect((await rows()).ab).toMatchObject({ status: 'REJETE', rejectReason: 'Pas le même sinistre' });
  });

  it('une ligne miroir déjà tranchée n’est pas écrasée', async () => {
    const { ab, ba } = await rows();
    await service.decide(ba.id, { action: 'complement' }, 'Opérateur', operateur);
    await service.decide(ab.id, { action: 'confirm' }, 'Opérateur', operateur);
    const after = await rows();
    expect(after.ab.status).toBe('CONFIRME_MANUEL');
    expect(after.ba.status).toBe('COMPLEMENT');
  });

  it('une demande de complément ne se propage pas', async () => {
    const { ab } = await rows();
    const before = (await rows()).ba.status;
    await service.decide(ab.id, { action: 'complement' }, 'Opérateur', operateur);
    expect((await rows()).ba.status).toBe(before);
  });

  it('403 (pas 404) pour une compagnie hors de la paire, sans rien modifier', async () => {
    const { ab } = await rows();
    await expect(service.decide(ab.id, { action: 'confirm' }, 'CASH', tiers)).rejects.toMatchObject({ status: 403 });
    expect((await rows()).ab.status).not.toBe('CONFIRME_MANUEL');
  });

  it('404 pour un élément inconnu', async () => {
    await expect(service.decide('inconnu', { action: 'confirm' }, 'Opérateur', operateur)).rejects.toMatchObject({ status: 404 });
  });
});
