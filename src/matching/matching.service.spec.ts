import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ForbiddenException } from '@nestjs/common';
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
    findAndCount: fail,
    count: fail,
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
  let assertCompanyActiveFor: jest.Mock;

  beforeEach(async () => {
    realtime = { emitEvent: jest.fn() };
    assertCompanyActiveFor = jest.fn(async () => undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        MatchingService,
        { provide: getRepositoryToken(MatchQueueItem), useFactory: throwingRepo },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: RealtimeGateway, useValue: realtime },
        { provide: AdherentsService, useValue: { publishedBaremeCases: async () => [], assertCompanyActiveFor } },
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

  it('refuse (403) de trancher une confrontation dont une compagnie n’est plus active, sans rien modifier (audit sécurité 2026-10-19)', async () => {
    const { ab } = await rows();
    assertCompanyActiveFor.mockImplementation(async (code: string) => {
      if (code === 'SAA') throw new ForbiddenException({ code: 'COMPAGNIE_NON_ACTIVE', message: 'SAA retirée (test)' });
    });
    await expect(service.decide(ab.id, { action: 'confirm' }, 'Opérateur', operateur)).rejects.toMatchObject({ response: { code: 'COMPAGNIE_NON_ACTIVE' } });
    expect(assertCompanyActiveFor).toHaveBeenCalledWith('CAAT', '2026-10-01');
    const after = await rows();
    expect(after.ab.status).not.toBe('CONFIRME_MANUEL');
    expect(after.ba.status).not.toBe('CONFIRME_MANUEL');
  });
});

describe('MatchingService — SEC-03 (seuil, compagnie désignée, masquage)', () => {
  let service: MatchingService;
  const caat: AuthenticatedUser = { id: 'c', name: 'Correspondant CAAT', email: 'c@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'CAAT', privileges: ['matchDecide'] };

  // Pas d'e-constat partagé : plaques + polices + compagnies croisées = 60 (MANUEL, à confirmer).
  const a: ClaimMatchInput = { id: 'clm-ma', numEconstat: 'EC-MA', company: 'CAAT', counterpartyCompany: 'SAA', plateA: '111', plateB: '222', policeA: 'PA', policeB: 'PB', assureIdentite: 'Assuré CAAT' };
  const b: ClaimMatchInput = { id: 'clm-mb', numEconstat: 'EC-MB', company: 'SAA', counterpartyCompany: 'CAAT', plateA: '222', plateB: '111', policeA: 'PB', policeB: 'PA', assureIdentite: 'Assuré SAA' };
  // Même e-constat que A mais compagnie non désignée par A.
  const intrus: ClaimMatchInput = { id: 'clm-x', numEconstat: 'EC-MA', company: 'CASH', counterpartyCompany: 'CAAT', plateA: '999', assureIdentite: 'Assuré CASH' };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        MatchingService,
        { provide: getRepositoryToken(MatchQueueItem), useFactory: throwingRepo },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: RealtimeGateway, useValue: { emitEvent: jest.fn() } },
        { provide: AdherentsService, useValue: { publishedBaremeCases: async () => [], assertCompanyActiveFor: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(MatchingService);
    await service.ingestClaims([intrus, a, b], { byKeys: async () => [intrus, a, b], all: async () => [intrus, a, b] });
  });

  it('la ligne de A est appariée à SAA (désignée), jamais à CASH malgré l’e-constat commun', async () => {
    const { items } = await service.queue({ page: 1, pageSize: 100 } as never);
    expect(items.find((i) => i.refA === 'EC-MA' && i.companyA === 'CAAT')).toMatchObject({ companyB: 'SAA', level: 'MANUEL', status: 'A_CONFIRMER' });
  });

  it('CAAT lit la file : aucun champ nominatif de SAA tant que la paire n’est pas confirmée, ni l’id de son dossier', async () => {
    const { items } = await service.queue({ page: 1, pageSize: 100 } as never, caat);
    const row = items.find((i) => i.refA === 'EC-MA' && i.companyA === 'CAAT')!;
    expect(row).toMatchObject({ masked: true, plateB: '••••', policeB: '••••', assureBIdentite: '••••', assureAIdentite: 'Assuré CAAT' });
    expect(JSON.stringify(items)).not.toContain('Assuré SAA');
    const detail = await service.getItem(row.id, caat);
    expect(detail.claimAId).toBe('clm-ma');
    expect(detail.claimBId).toBeUndefined();
  });

  it('après confirmation, les champs de la contrepartie sont publiés', async () => {
    const { items } = await service.queue({ page: 1, pageSize: 100 } as never, caat);
    const row = items.find((i) => i.refA === 'EC-MA' && i.companyA === 'CAAT')!;
    await service.decide(row.id, { action: 'confirm' }, 'Correspondant CAAT', caat);
    const detail = await service.getItem(row.id, caat);
    expect(detail).toMatchObject({ assureBIdentite: 'Assuré SAA', claimBId: 'clm-mb' });
    expect(detail.masked).toBeUndefined();
  });
});

describe('MatchingService — SEC-07 (diffusion temps réel ciblée et minimale)', () => {
  it('une décision ne part qu’aux salons de la place et des deux parties, sans donnée nominative ; le détail reste interne', async () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const gateway = new RealtimeGateway({ resolve: async () => null });
    gateway.server = { to } as never;
    const internal = jest.fn();
    gateway.onEvent('match.updated', internal);

    const moduleRef = await Test.createTestingModule({
      providers: [
        MatchingService,
        { provide: getRepositoryToken(MatchQueueItem), useFactory: throwingRepo },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: RealtimeGateway, useValue: gateway },
        { provide: AdherentsService, useValue: { publishedBaremeCases: async () => [], assertCompanyActiveFor: jest.fn() } },
      ],
    }).compile();
    const service = moduleRef.get(MatchingService);
    const a: ClaimMatchInput = { ...declA, id: 'rt-a', numEconstat: 'EC-RT', assureIdentite: 'Nom A' };
    const b: ClaimMatchInput = { ...declB, id: 'rt-b', numEconstat: 'EC-RT', assureIdentite: 'Nom B' };
    await service.ingestClaims([a, b], { byKeys: async () => [a, b], all: async () => [a, b] });

    // Ingestion : seulement CAAT/SAA (+ place), sans l'id du dossier de la contrepartie.
    expect(to).toHaveBeenCalledWith(['tenant:place', 'tenant:CAAT', 'tenant:SAA']);
    expect(emit).toHaveBeenCalledWith('match.updated', { claimId: 'rt-a', matched: true });

    const { items } = await service.queue({ page: 1, pageSize: 100 } as never);
    const row = items.find((i) => i.refA === 'EC-RT' && i.companyA === 'CAAT')!;
    to.mockClear();
    emit.mockClear();
    internal.mockClear();
    await service.decide(row.id, { action: 'confirm' }, 'Agent Opérateur', operateur);

    for (const call of to.mock.calls as unknown as string[][][]) expect([...call[0]].sort()).toEqual(['tenant:CAAT', 'tenant:SAA', 'tenant:place']);
    const wsPayloads = emit.mock.calls.map(([, p]) => p);
    expect(wsPayloads).toEqual([
      { id: row.id, status: 'CONFIRME_MANUEL', level: 'AUTO', decidedAt: expect.any(String) },
      expect.objectContaining({ status: 'CONFIRME_MANUEL' }),
    ]);
    expect(JSON.stringify(wsPayloads)).not.toMatch(/Nom A|Nom B|Agent Opérateur|111|222/);
    // FraudModule (journal des actions) reçoit toujours la décision complète.
    expect(internal).toHaveBeenCalledWith(expect.objectContaining({ decision: expect.objectContaining({ decidedBy: 'Agent Opérateur', status: 'CONFIRME_MANUEL' }) }));
  });
});

describe('MatchingService — SEC-28 (historique et re-décision motivée)', () => {
  let service: MatchingService;
  const caat: AuthenticatedUser = { id: 'u-caat', name: 'Agent CAAT', email: 'a@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'CAAT', privileges: ['matchDecide'] };
  const saa: AuthenticatedUser = { id: 'u-saa', name: 'Agent SAA', email: 'a@saa.dz', role: 'CORRESPONDANT_IDA', companyId: 'SAA', privileges: ['matchDecide'] };
  const a: ClaimMatchInput = { ...declA, id: '11111111-1111-4111-8111-111111111111', numEconstat: 'EC-H' };
  const b: ClaimMatchInput = { ...declB, id: '22222222-2222-4222-8222-222222222222', numEconstat: 'EC-H' };
  const other: ClaimMatchInput = { id: '33333333-3333-4333-8333-333333333333', numEconstat: 'EC-O', company: 'CASH', plateA: '999' };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        MatchingService,
        { provide: getRepositoryToken(MatchQueueItem), useFactory: throwingRepo },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: RealtimeGateway, useValue: { emitEvent: jest.fn() } },
        { provide: AdherentsService, useValue: { publishedBaremeCases: async () => [], assertCompanyActiveFor: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(MatchingService);
    await service.ingestClaims([a, b, other], { byKeys: async () => [a, b, other], all: async () => [a, b, other] });
  });

  async function rowOf(companyA: string) {
    const { items } = await service.queue({ page: 1, pageSize: 100 } as never);
    return items.find((i) => i.refA === 'EC-H' && i.companyA === companyA)!;
  }

  it('chaque décision est historisée (auteur, rôle, compagnie, état avant/après, motif)', async () => {
    const ab = await rowOf('CAAT');
    await service.decide(ab.id, { action: 'confirm' }, 'Agent CAAT', caat);
    const history = await service.decisionHistory(ab.id, caat);
    expect(history).toEqual([
      expect.objectContaining({ action: 'confirm', previousStatus: 'AUTO_CONFIRME', newStatus: 'CONFIRME_MANUEL', decidedBy: 'Agent CAAT', decidedByRole: 'CORRESPONDANT_IDA', decidedByCompany: 'CAAT' }),
    ]);
  });

  it('B ne peut défaire la décision de A qu’avec un motif, et la re-décision est historisée', async () => {
    const ab = await rowOf('CAAT');
    await service.decide(ab.id, { action: 'confirm' }, 'Agent CAAT', caat);
    await expect(service.decide(ab.id, { action: 'reject' }, 'Agent SAA', saa)).rejects.toMatchObject({ status: 400, response: { code: 'MOTIF_REQUIS' } });
    await service.decide(ab.id, { action: 'reject', reason: 'Pas le même sinistre' }, 'Agent SAA', saa);
    const history = await service.decisionHistory(ab.id, saa);
    expect(history.map((h) => [h.action, h.previousStatus, h.newStatus])).toEqual([
      ['confirm', 'AUTO_CONFIRME', 'CONFIRME_MANUEL'],
      ['reject', 'CONFIRME_MANUEL', 'REJETE'],
    ]);
    // Le nom de l'agent de CAAT n'est pas publié à SAA (SEC-26) ; son propre nom l'est.
    expect(history[0].decidedBy).toBe('Compagnie CAAT');
    expect(history[1]).toMatchObject({ decidedBy: 'Agent SAA', reason: 'Pas le même sinistre' });
    expect((await service.queue({ page: 1, pageSize: 100 } as never, caat)).items.find((i) => i.id === ab.id)?.confirmedBy).toBe('Compagnie SAA');
  });

  it('link : linkDeclId obligatoire, existant, d’une autre compagnie que A', async () => {
    const ab = await rowOf('CAAT');
    await expect(service.decide(ab.id, { action: 'link' }, 'Agent CAAT', caat)).rejects.toMatchObject({ response: { code: 'LIEN_REQUIS' } });
    await expect(service.decide(ab.id, { action: 'link', linkDeclId: '99999999-9999-4999-8999-999999999999' }, 'Agent CAAT', caat)).rejects.toMatchObject({ status: 404 });
    await expect(service.decide(ab.id, { action: 'link', linkDeclId: a.id }, 'Agent CAAT', caat)).rejects.toMatchObject({ response: { code: 'LIEN_INVALIDE' } });
    await expect(service.decide(ab.id, { action: 'link', linkDeclId: other.id }, 'Agent CAAT', caat)).resolves.toMatchObject({ status: 'CONFIRME_MANUEL' });
  });

  it('historique : même périmètre que le détail (403 pour une compagnie tierce)', async () => {
    const ab = await rowOf('CAAT');
    const cash: AuthenticatedUser = { ...caat, companyId: 'CASH' };
    await expect(service.decisionHistory(ab.id, cash)).rejects.toMatchObject({ status: 403 });
  });
});
