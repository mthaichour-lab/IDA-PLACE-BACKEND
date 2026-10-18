import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { Recours } from '../recours/entities/recours.entity';
import { RecoursService } from '../recours/recours.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import { CommissionService } from './commission.service';
import { CommissionCase } from './entities/commission-case.entity';
import { Sanction } from './entities/sanction.entity';

/** Acteur "place" — voir recours.service.spec.ts. */
function fakeUser(name: string): AuthenticatedUser {
  return { id: name, name, email: `${name}@test.local`, role: 'OPERATEUR_PLACE', privileges: [] };
}

/** Repli mémoire forcé — voir recours.service.spec.ts / claims.service.spec.ts. */
function throwingRepo() {
  return {
    create: jest.fn((data: unknown) => data),
    findOne: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    findAll: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    getEntityManager: jest.fn(() => ({
      persist: jest.fn(),
      persistAndFlush: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
      flush: jest.fn().mockRejectedValue(new Error('DB injoignable (test)')),
    })),
  };
}

function fakeConfigService() {
  return { get: () => undefined } as unknown as ConfigService;
}

describe('CommissionService (mode dégradé — file de conciliation, pénalités/sanctions, PV)', () => {
  let commission: CommissionService;
  let recours: RecoursService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CommissionService,
        RecoursService,
        { provide: getRepositoryToken(CommissionCase), useFactory: throwingRepo },
        { provide: getRepositoryToken(Sanction), useFactory: throwingRepo },
        { provide: getRepositoryToken(Recours), useFactory: throwingRepo },
        { provide: ConfigService, useFactory: fakeConfigService },
        { provide: RealtimeGateway, useValue: { emitEvent: jest.fn() } },
      ],
    }).compile();

    commission = moduleRef.get(CommissionService);
    recours = moduleRef.get(RecoursService);
  });

  async function openCaseFromFreshRecours() {
    const r = await recours.create({ claimId: 'clm-1', from: 'CAAT', to: 'SAA', amount: 75_000 });
    await recours.transition(r.id, { action: 'opposer' }, fakeUser('saa.correspondant'));
    await recours.transition(r.id, { action: 'contester' }, fakeUser('caat.correspondant'));
    await recours.transition(r.id, { action: 'transmettre_commission' }, fakeUser('caat.correspondant'));
    return commission.createCase({ recoursId: r.id, motif: 'Désaccord sur le montant' });
  }

  it('createCase() dénormalise claimId/companyA/companyB/amount depuis le recours', async () => {
    const created = await openCaseFromFreshRecours();
    expect(created.companyA).toBe('CAAT');
    expect(created.companyB).toBe('SAA');
    expect(created.amount).toBe(75_000);
    expect(created.status).toBe('A_INSTRUIRE');
  });

  it('createCase() renvoie un 404 normalisé si le recours est inconnu', async () => {
    await expect(commission.createCase({ recoursId: 'inconnu', motif: 'x' })).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });

  it('décider sans avoir délibéré est rejeté (400, jamais un faux 404)', async () => {
    const created = await openCaseFromFreshRecours();
    await expect(commission.decide(created.id, { outcome: 'RECOURS_FONDE' })).rejects.toMatchObject({
      response: { code: 'INVALID_TRANSITION' },
    });
  });

  it('parcours complet : deliberate -> decide -> pv-sign', async () => {
    const created = await openCaseFromFreshRecours();
    const deliberated = await commission.deliberate(created.id);
    expect(deliberated.status).toBe('EN_DELIBERE');

    const decided = await commission.decide(created.id, { outcome: 'RECOURS_FONDE', motif: 'Pièces conformes' });
    expect(decided.status).toBe('PRONONCE');
    expect(decided.decision?.outcome).toBe('RECOURS_FONDE');

    const signed = await commission.pvSign(created.id, {}, 'membre.commission');
    expect(signed.pv?.signedBy).toBe('membre.commission');
    expect(signed.pv?.ref).toContain(created.id);
  });

  it('pv-sign avant le prononcé est rejeté (400)', async () => {
    const created = await openCaseFromFreshRecours();
    await expect(commission.pvSign(created.id, {}, 'x')).rejects.toMatchObject({ response: { code: 'INVALID_TRANSITION' } });
  });

  it('penalty() accepte une compagnie partie au recours et la rejette sinon', async () => {
    const created = await openCaseFromFreshRecours();
    const penalty = await commission.penalty(created.id, { companyCode: 'SAA', amount: 20_000, reason: 'Retard de traitement' }, 'membre.commission');
    expect(penalty.type).toBe('PENALITE_FINANCIERE');
    expect(penalty.companyCode).toBe('SAA');

    await expect(
      commission.penalty(created.id, { companyCode: 'CASH', amount: 1000, reason: 'x' }, 'membre.commission'),
    ).rejects.toMatchObject({ response: { code: 'BAD_REQUEST' } });
  });

  it('sanction() persiste une sanction non financière et listSanctions() la retrouve filtrée par compagnie', async () => {
    const created = await openCaseFromFreshRecours();
    await commission.sanction(created.id, { companyCode: 'CAAT', type: 'AVERTISSEMENT', reason: 'Qualité de dossier' }, 'membre.commission');

    const all = await commission.listSanctions({ page: 1, pageSize: 6 });
    expect(all.items).toHaveLength(1);

    const filtered = await commission.listSanctions({ company: 'CAAT', page: 1, pageSize: 6 });
    expect(filtered.items).toHaveLength(1);
    const none = await commission.listSanctions({ company: 'INCONNU', page: 1, pageSize: 6 });
    expect(none.items).toHaveLength(0);
  });

  it('listCases()/getCase() reflètent le repli mémoire et filtrent par statut', async () => {
    const created = await openCaseFromFreshRecours();
    await commission.deliberate(created.id);

    const list = await commission.listCases({ status: 'EN_DELIBERE', page: 1, pageSize: 6 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0].id).toBe(created.id);

    const detail = await commission.getCase(created.id);
    expect(detail.status).toBe('EN_DELIBERE');

    await expect(commission.getCase('inconnu')).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });

  describe('summary() — KPI de synthèse (écran 7, guide illustré)', () => {
    it('compte les dossiers pendants et ceux hors délai Art.24 (15 jours)', async () => {
      const recent = await openCaseFromFreshRecours();

      jest.useFakeTimers().setSystemTime(new Date(Date.now() - 20 * 86_400_000));
      const overdue = await openCaseFromFreshRecours();
      jest.useRealTimers();

      const summary = await commission.summary();
      expect(summary.pendingCount).toBe(2); // les deux restent A_INSTRUIRE
      expect(summary.overdue15dCount).toBe(1); // seul le dossier ouvert il y a 20 jours dépasse les 15 jours Art.24

      await commission.deliberate(recent.id);
      await commission.decide(recent.id, { outcome: 'RECOURS_REJETE' });
      const afterDecision = await commission.summary();
      expect(afterDecision.pendingCount).toBe(1); // "recent" est désormais PRONONCE, ne compte plus comme pendant
    });

    it('compte les dossiers PRONONCE avec décision RECOURS_FONDE', async () => {
      const a = await openCaseFromFreshRecours();
      const b = await openCaseFromFreshRecours();
      await commission.deliberate(a.id);
      await commission.decide(a.id, { outcome: 'RECOURS_FONDE' });
      await commission.deliberate(b.id);
      await commission.decide(b.id, { outcome: 'RECOURS_REJETE' });

      const summary = await commission.summary();
      expect(summary.recoursFondesCount).toBe(1);
    });

    it('compte les oppositions réputées fondées (Art.12) comme une mesure RecoursModule, indépendante des dossiers de commission', async () => {
      // Un recours dont l'opposition n'est JAMAIS traitée dans le délai Art.12 (15 jours) devient
      // automatiquement OPPOSITION_FONDEE_ART12 — sans jamais passer par un dossier de commission.
      const r = await recours.create({ claimId: 'clm-art12', from: 'CAAT', to: 'SAA', amount: 50_000 });
      await recours.transition(r.id, { action: 'opposer' }, fakeUser('saa.correspondant'));

      jest.useFakeTimers().setSystemTime(new Date(Date.now() + 16 * 86_400_000));
      const summary = await commission.summary();
      jest.useRealTimers();

      expect(summary.oppositionsFondeesCount).toBe(1);
      expect(summary.pendingCount).toBe(0); // confirme qu'aucun dossier de commission n'a été créé pour ce recours
    });
  });
});
