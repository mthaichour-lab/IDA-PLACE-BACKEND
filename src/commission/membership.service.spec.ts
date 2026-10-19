import { getRepositoryToken } from '@mikro-orm/nestjs';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AdherentsService } from '../adherents/adherents.service';
import { CLOCK } from '../common/clock';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { MembershipRequest } from './entities/membership-request.entity';
import { MembershipService } from './membership.service';
import { simulatedDatabaseOutage, simulatedOutageEntityManager } from '../common/database/db-errors';

const OPERATEUR: AuthenticatedUser = { id: 'op', name: 'operateur', email: 'op@test.local', role: 'OPERATEUR_PLACE', privileges: [] };

function correspondant(companyId: string): AuthenticatedUser {
  return { id: `c-${companyId}`, name: `correspondant.${companyId}`, email: 'c@test.local', role: 'CORRESPONDANT_IDA', companyId, privileges: [] };
}

/** Repli mémoire forcé — voir commission.service.spec.ts. */
function throwingRepo() {
  return {
    create: jest.fn((data: unknown) => data),
    findOne: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    findAll: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    getEntityManager: jest.fn(() => simulatedOutageEntityManager({
      persistAndFlush: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
      flush: jest.fn().mockRejectedValue(simulatedDatabaseOutage()),
    })),
  };
}

const COMPANIES: Record<string, { id: string; code: string; status: string }> = {
  'c-caat': { id: 'c-caat', code: 'CAAT', status: 'ACTIF' },
  'c-saa': { id: 'c-saa', code: 'SAA', status: 'ACTIF' },
};

describe('MembershipService (mode dégradé — adhésions et retraits, Art. 30-35)', () => {
  let service: MembershipService;
  let now: Date;
  let adherents: { getCompany: jest.Mock; markCompanyWithdrawn: jest.Mock };

  beforeEach(async () => {
    now = new Date('2026-10-18T10:00:00Z');
    adherents = {
      getCompany: jest.fn(async (id: string) => {
        const c = COMPANIES[id];
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Compagnie introuvable.' });
        return c;
      }),
      markCompanyWithdrawn: jest.fn(async (id: string) => ({ ...COMPANIES[id], status: 'EN_RETRAIT' })),
    };
    service = await build();
  });

  async function build(config: Record<string, string> = {}) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        MembershipService,
        { provide: getRepositoryToken(MembershipRequest), useFactory: throwingRepo },
        { provide: AdherentsService, useValue: adherents },
        { provide: CLOCK, useValue: () => now },
        { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
      ],
    }).compile();
    return moduleRef.get(MembershipService);
  }

  const adhesion = () => service.create({ type: 'ADHESION', receivedAt: '2026-10-01', candidateName: 'Nouvelle Assurance', letterRef: 'UAR/2026/101' }, OPERATEUR);
  const retrait = (receivedAt = '2026-09-30', companyId = 'c-saa') => service.create({ type: 'RETRAIT', receivedAt, companyId, letterRef: `UAR/${receivedAt}` }, OPERATEUR);

  describe('création', () => {
    it('ADHESION exige la raison sociale de la candidate (400)', async () => {
      await expect(service.create({ type: 'ADHESION', receivedAt: '2026-10-01', letterRef: 'L' }, OPERATEUR)).rejects.toMatchObject({ status: 400 });
    });

    it('ADHESION ne se lie pas à une compagnie à la création (400)', async () => {
      await expect(service.create({ type: 'ADHESION', receivedAt: '2026-10-01', candidateName: 'X', companyId: 'c-caat', letterRef: 'L' }, OPERATEUR)).rejects.toMatchObject({ status: 400 });
    });

    it('RETRAIT exige une compagnie existante (400 sans, 404 inconnue)', async () => {
      await expect(service.create({ type: 'RETRAIT', receivedAt: '2026-09-30', letterRef: 'L' }, OPERATEUR)).rejects.toMatchObject({ status: 400 });
      await expect(retrait('2026-09-30', 'inconnue')).rejects.toMatchObject({ status: 404 });
    });

    it('RETRAIT calcule la date d’effet et dénormalise le code compagnie', async () => {
      const r = await retrait('2026-09-30');
      expect(r).toMatchObject({ type: 'RETRAIT', state: 'RECUE', companyId: 'c-saa', companyCode: 'SAA', effectiveDate: '2026-12-31', createdBy: 'operateur' });
      const late = await retrait('2026-10-01', 'c-caat');
      expect(late.effectiveDate).toBe('2027-12-31');
    });

    it('refuse un second retrait en cours pour la même compagnie (409)', async () => {
      await retrait();
      await expect(retrait('2026-10-02')).rejects.toMatchObject({ status: 409 });
    });

    it('refuse une date de réception future ou invalide (400)', async () => {
      await expect(retrait('2026-10-19')).rejects.toMatchObject({ status: 400 });
      await expect(retrait('2026-02-30')).rejects.toMatchObject({ status: 400 });
    });

    it('SEC-47 : un retrait reçu en octobre ne peut pas être antidaté au 30/09 au-delà du plafond (400 DATE_RECEPTION_TROP_ANCIENNE)', async () => {
      now = new Date('2026-10-20T10:00:00Z');
      // 30/09 est à 20 jours : accepté avec le plafond par défaut (30 jours).
      await expect(retrait('2026-09-30')).resolves.toMatchObject({ effectiveDate: '2026-12-31' });
      // Avec un plafond de 7 jours, le même antidatage est refusé.
      const strict = await build({ MEMBERSHIP_RECEIVED_MAX_AGE_DAYS: '7' });
      await expect(strict.create({ type: 'RETRAIT', receivedAt: '2026-09-30', companyId: 'c-caat', letterRef: 'L' }, OPERATEUR)).rejects.toMatchObject({ status: 400, response: { code: 'DATE_RECEPTION_TROP_ANCIENNE' } });
      await expect(strict.create({ type: 'RETRAIT', receivedAt: '2026-10-14', companyId: 'c-caat', letterRef: 'L' }, OPERATEUR)).resolves.toMatchObject({ effectiveDate: '2027-12-31' });
    });

    it('SEC-47 : une date plus ancienne que le plafond par défaut (30 jours) est refusée', async () => {
      await expect(retrait('2026-09-17')).rejects.toMatchObject({ response: { code: 'DATE_RECEPTION_TROP_ANCIENNE' } });
    });

    it('SEC-47 : la référence du courrier est obligatoire et conservée', async () => {
      await expect(service.create({ type: 'RETRAIT', receivedAt: '2026-10-01', companyId: 'c-saa', letterRef: '  ' }, OPERATEUR)).rejects.toMatchObject({ status: 400 });
      await expect(retrait('2026-10-01')).resolves.toMatchObject({ letterRef: 'UAR/2026-10-01' });
    });

    it('SEC-48 : un plafond invalide fait échouer la construction', async () => {
      await expect(build({ MEMBERSHIP_RECEIVED_MAX_AGE_DAYS: 'abc' })).rejects.toThrow(/Configuration invalide/);
    });

    it('SEC-25 : un utilisateur compagnie (même avec le privilège membership) ne peut instruire (403)', async () => {
      const derogation = { ...correspondant('CAAT'), privileges: ['membership'] } as AuthenticatedUser;
      await expect(service.create({ type: 'RETRAIT', receivedAt: '2026-10-01', companyId: 'c-caat', letterRef: 'L' }, derogation)).rejects.toMatchObject({ status: 403 });
      const r = await retrait();
      await expect(service.cancel(r.id, undefined, derogation)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('ADHESION', () => {
    it('acceptation sans référence d’agrément refusée (400), puis acceptée avec', async () => {
      const a = await adhesion();
      await expect(service.accept(a.id, {}, OPERATEUR)).rejects.toMatchObject({ status: 400 });
      const accepted = await service.accept(a.id, { agrementRef: 'AGR-AUTO-2026-01' }, OPERATEUR);
      expect(accepted).toMatchObject({ state: 'ACCEPTEE', agrementRef: 'AGR-AUTO-2026-01', decidedBy: 'operateur', decidedAt: now.toISOString() });
    });

    it('acceptation avec liaison à une compagnie existante du référentiel', async () => {
      const a = await adhesion();
      const accepted = await service.accept(a.id, { agrementRef: 'AGR-1', companyId: 'c-caat' }, OPERATEUR);
      expect(accepted).toMatchObject({ companyId: 'c-caat', companyCode: 'CAAT' });
      const b = await adhesion();
      await expect(service.accept(b.id, { agrementRef: 'AGR-2', companyId: 'inconnue' }, OPERATEUR)).rejects.toMatchObject({ status: 404 });
    });

    it('refuse (400 COMPAGNIE_NON_ACTIVE) de lier une adhésion à une compagnie déjà EXCLU/EN_RETRAIT — une réadhésion passe par une nouvelle demande', async () => {
      adherents.getCompany.mockResolvedValueOnce({ id: 'c-tala', code: 'TALA', status: 'EXCLU' });
      const a = await adhesion();
      await expect(service.accept(a.id, { agrementRef: 'AGR-1', companyId: 'c-tala' }, OPERATEUR)).rejects.toMatchObject({
        response: { code: 'COMPAGNIE_NON_ACTIVE' },
      });
    });

    it('rejet motivé, puis toute nouvelle décision est un 409', async () => {
      const a = await adhesion();
      const rejected = await service.reject(a.id, { decisionNote: 'Agrément branche automobile non justifié' }, OPERATEUR);
      expect(rejected).toMatchObject({ state: 'REJETEE', decisionNote: 'Agrément branche automobile non justifié' });
      await expect(service.accept(a.id, { agrementRef: 'AGR-1' }, OPERATEUR)).rejects.toMatchObject({ status: 409 });
      await expect(service.reject(a.id, { decisionNote: 'x' }, OPERATEUR)).rejects.toMatchObject({ status: 409 });
    });

    it('ni constat d’effet ni annulation sur une adhésion (409)', async () => {
      const a = await adhesion();
      await expect(service.markEffective(a.id, undefined, OPERATEUR)).rejects.toMatchObject({ status: 409 });
      await expect(service.cancel(a.id, undefined, OPERATEUR)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('RETRAIT', () => {
    it('pas de rejet ni d’acceptation sur un retrait (409)', async () => {
      const r = await retrait();
      await expect(service.reject(r.id, { decisionNote: 'non' }, OPERATEUR)).rejects.toMatchObject({ status: 409 });
      await expect(service.accept(r.id, { agrementRef: 'AGR' }, OPERATEUR)).rejects.toMatchObject({ status: 409 });
    });

    it('constat d’effet refusé (409) tant que la date d’effet n’est pas passée, sans toucher la compagnie', async () => {
      const r = await retrait();
      now = new Date('2026-12-31T23:00:00Z');
      await expect(service.markEffective(r.id, undefined, OPERATEUR)).rejects.toMatchObject({ status: 409 });
      expect(adherents.markCompanyWithdrawn).not.toHaveBeenCalled();
    });

    it('constat d’effet après la date d’effet : EFFECTIVE et compagnie passée EN_RETRAIT', async () => {
      const r = await retrait();
      now = new Date('2027-01-01T08:00:00Z');
      const effective = await service.markEffective(r.id, 'Courrier du 30/09', OPERATEUR);
      expect(effective).toMatchObject({ state: 'EFFECTIVE', decisionNote: 'Courrier du 30/09' });
      expect(adherents.markCompanyWithdrawn).toHaveBeenCalledWith('c-saa', r.effectiveDate, OPERATEUR);
      await expect(service.cancel(r.id, undefined, OPERATEUR)).rejects.toMatchObject({ status: 409 });
    });

    it('SEC-47 : si le passage EN_RETRAIT échoue, la demande reste RECUE (écritures liées)', async () => {
      const r = await retrait();
      now = new Date('2027-01-01T08:00:00Z');
      adherents.markCompanyWithdrawn.mockRejectedValueOnce(new Error('échec écriture compagnie'));
      await expect(service.markEffective(r.id, undefined, OPERATEUR)).rejects.toThrow();
      expect((await service.get(r.id)).state).toBe('RECUE');
    });

    it('SEC-33 : deux décisions concurrentes sur la même demande — une seule réussit (409 pour l’autre)', async () => {
      const r = await retrait();
      const results = await Promise.allSettled([service.cancel(r.id, 'a', OPERATEUR), service.cancel(r.id, 'b', OPERATEUR)]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.getStatus()).toBe(409);
    });

    it('annulation : ANNULEE, puis un nouveau retrait redevient possible', async () => {
      const r = await retrait();
      expect(await service.cancel(r.id, 'Retrait retiré par l’adhérent', OPERATEUR)).toMatchObject({ state: 'ANNULEE' });
      await expect(retrait('2026-10-02')).resolves.toMatchObject({ state: 'RECUE' });
    });

    it('404 normalisé sur une demande inconnue', async () => {
      await expect(service.cancel('inconnue', undefined, OPERATEUR)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('lecture scopée par compagnie (B.7)', () => {
    it('un utilisateur compagnie ne voit que les demandes de SA compagnie, jamais une adhésion non liée', async () => {
      const saa = await retrait('2026-09-30', 'c-saa');
      const caat = await retrait('2026-09-30', 'c-caat');
      const candidate = await adhesion();

      const forCaat = await service.list({ page: 1, pageSize: 50 }, correspondant('CAAT'));
      expect(forCaat.items.map((r) => r.id)).toEqual([caat.id]);
      await expect(service.get(caat.id, correspondant('CAAT'))).resolves.toMatchObject({ companyCode: 'CAAT' });
      await expect(service.get(saa.id, correspondant('CAAT'))).rejects.toMatchObject({ status: 403 });
      await expect(service.get(candidate.id, correspondant('CAAT'))).rejects.toMatchObject({ status: 403 });

      const forPlace = await service.list({ page: 1, pageSize: 50 }, OPERATEUR);
      expect(forPlace.total).toBe(3);
    });

    it('filtres type et état', async () => {
      await retrait();
      const a = await adhesion();
      await service.reject(a.id, { decisionNote: 'motif' }, OPERATEUR);
      expect((await service.list({ type: 'RETRAIT', page: 1, pageSize: 50 }, OPERATEUR)).total).toBe(1);
      expect((await service.list({ state: 'REJETEE', page: 1, pageSize: 50 }, OPERATEUR)).items[0].id).toBe(a.id);
    });
  });
});
