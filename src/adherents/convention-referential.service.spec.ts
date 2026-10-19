import { EntityRepository } from '@mikro-orm/postgresql';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { ConventionReferentialService } from './convention-referential.service';
import { ConstatCircumstance } from './entities/constat-circumstance.entity';
import { MobileHoliday } from './entities/mobile-holiday.entity';
import { OppositionMotif } from './entities/opposition-motif.entity';
import { NON_DECLARATION_MOTIF_CODE } from './place-referential.data';

/** Repli mémoire forcé : toute opération base échoue (voir adherents.service.spec.ts). */
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

describe('ConventionReferentialService (mode dégradé)', () => {
  let service: ConventionReferentialService;
  const operateur = user('op-1');
  const adminUar = user('uar-1', 'ADMIN_UAR');

  beforeEach(() => {
    service = new ConventionReferentialService(throwingRepo<MobileHoliday>(), throwingRepo<ConstatCircumstance>(), throwingRepo<OppositionMotif>());
  });

  describe('données pré-remplies (seed)', () => {
    it('17 circonstances du constat, toutes STANDARD_A_CONFIRMER, sans libellé arabe', async () => {
      const list = await service.listCircumstances();
      expect(list.map((c) => c.number)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
      expect(list.every((c) => c.status === 'STANDARD_A_CONFIRMER' && c.labelAr === undefined)).toBe(true);
    });

    it('un seul motif pré-rempli : « Non-déclaration du sinistre », interdit, source diapo 10', async () => {
      const motifs = await service.listMotifs();
      expect(motifs).toHaveLength(1);
      expect(motifs[0]).toMatchObject({ code: NON_DECLARATION_MOTIF_CODE, forbidden: true, sourceRef: expect.stringContaining('diapo 10') });
    });

    it('aucune date de férié mobile pré-remplie', async () => {
      expect(await service.listHolidays()).toEqual([]);
      expect(await service.extraHolidays('2000-01-01', '2100-12-31')).toEqual([]);
    });
  });

  describe('motif d’opposition (reasonCode)', () => {
    it('refuse un motif interdit avec un 400 qui cite l’Art. 10 et la diapo 10', async () => {
      const err = await service.assertOppositionMotifUsable(NON_DECLARATION_MOTIF_CODE).catch((e) => e);
      expect(err.getStatus()).toBe(400);
      expect(err.response.code).toBe('MOTIF_INTERDIT');
      expect(err.response.message).toMatch(/Art\. 10/);
      expect(err.response.message).toMatch(/diapo 10/);
    });

    it('refuse un motif inconnu avec un 400', async () => {
      await expect(service.assertOppositionMotifUsable('INCONNU')).rejects.toMatchObject({ response: { code: 'MOTIF_INCONNU' } });
    });

    it('accepte un motif saisi non interdit', async () => {
      await service.createMotif({ code: 'MONTANT_CONTESTE', label: 'Montant contesté' }, operateur);
      await expect(service.assertOppositionMotifUsable('MONTANT_CONTESTE')).resolves.toMatchObject({ code: 'MONTANT_CONTESTE' });
    });

    it('refuse un doublon de code (409)', async () => {
      await expect(service.createMotif({ code: NON_DECLARATION_MOTIF_CODE, label: 'x' }, operateur)).rejects.toMatchObject({ response: { code: 'CONFLICT' } });
    });
  });

  describe('règle des quatre yeux (validatedBy ≠ createdBy)', () => {
    it('409 quand l’auteur d’un motif tente de le valider', async () => {
      await service.createMotif({ code: 'PIECE_MANQUANTE', label: 'Pièce manquante' }, adminUar);
      await expect(service.validateMotif('PIECE_MANQUANTE', adminUar)).rejects.toMatchObject({ response: { code: 'FOUR_EYES' } });
    });

    it('valide quand le validateur est une autre personne', async () => {
      await service.createMotif({ code: 'PIECE_MANQUANTE', label: 'Pièce manquante' }, operateur);
      const validated = await service.validateMotif('PIECE_MANQUANTE', adminUar);
      expect(validated).toMatchObject({ status: 'VALIDE_UAR', validatedBy: 'uar-1' });
      await expect(service.validateMotif('PIECE_MANQUANTE', user('uar-2', 'ADMIN_UAR'))).rejects.toMatchObject({ response: { code: 'ALREADY_VALIDATED' } });
    });

    it('le dernier modificateur d’une circonstance ne peut pas la valider ; la modification annule une validation', async () => {
      await service.validateCircumstance(3, adminUar);
      const updated = await service.updateCircumstance(3, { labelAr: 'يركن' }, adminUar);
      expect(updated).toMatchObject({ status: 'STANDARD_A_CONFIRMER', updatedBy: 'uar-1' });
      expect(updated.validatedBy).toBeUndefined();
      await expect(service.validateCircumstance(3, adminUar)).rejects.toMatchObject({ response: { code: 'FOUR_EYES' } });
      await expect(service.validateCircumstance(3, user('uar-2', 'ADMIN_UAR'))).resolves.toMatchObject({ status: 'VALIDE_UAR', labelAr: 'يركن' });
    });

    it('404 pour une circonstance hors 1-17', async () => {
      await expect(service.validateCircumstance(18, adminUar)).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    });
  });

  describe('fériés mobiles (§2)', () => {
    it('un férié prévisionnel compte dès sa saisie ; la confirmation exige une référence et peut corriger la date', async () => {
      const h = await service.createHoliday({ date: '2026-03-20', kind: 'AID_EL_FITR', hijriYear: 1447 }, operateur);
      expect(h.status).toBe('PREVISIONNEL');
      expect(await service.extraHolidays('2026-03-01', '2026-03-31')).toEqual(['2026-03-20']);

      await expect(service.confirmHoliday(h.id, { sourceRef: '   ' }, operateur)).rejects.toMatchObject({ response: { code: 'BAD_REQUEST' } });
      const confirmed = await service.confirmHoliday(h.id, { sourceRef: 'Communiqué MAR 2026-03', date: '2026-03-21' }, adminUar);
      expect(confirmed).toMatchObject({ status: 'CONFIRME', date: '2026-03-21', sourceRef: 'Communiqué MAR 2026-03', confirmedBy: 'uar-1' });
      expect(await service.extraHolidays('2026-03-01', '2026-03-31')).toEqual(['2026-03-21']);

      await expect(service.updateHoliday(h.id, { date: '2026-03-22' })).rejects.toMatchObject({ response: { code: 'CONFLICT' } });
      await expect(service.removeHoliday(h.id)).rejects.toMatchObject({ response: { code: 'CONFLICT' } });
    });

    it('refuse un doublon (date, kind) et une date impossible', async () => {
      await service.createHoliday({ date: '2026-05-27', kind: 'AID_EL_ADHA' }, operateur);
      await expect(service.createHoliday({ date: '2026-05-27', kind: 'AID_EL_ADHA' }, operateur)).rejects.toMatchObject({ response: { code: 'CONFLICT' } });
      await expect(service.createHoliday({ date: '2026-02-30', kind: 'ACHOURA' }, operateur)).rejects.toMatchObject({ response: { code: 'BAD_REQUEST' } });
    });

    it('calendrier : union fixes + mobiles avec statut, bornes incluses ; extraHolidays ne renvoie que les mobiles', async () => {
      await service.createHoliday({ date: '2027-01-12', kind: 'AWAL_MOHARRAM' }, operateur);
      const cal = await service.calendarHolidays('2027-01-01', '2027-01-12');
      expect(cal).toEqual([
        { date: '2027-01-01', label: "Jour de l'an", type: 'FIXE', status: 'LEGAL' },
        { date: '2027-01-12', label: 'Yennayer', type: 'FIXE', status: 'LEGAL' },
        { date: '2027-01-12', label: 'Awal Moharram', type: 'MOBILE', kind: 'AWAL_MOHARRAM', status: 'PREVISIONNEL', sourceRef: undefined },
      ]);
      expect(await service.extraHolidays('2027-01-01', '2027-01-12')).toEqual(['2027-01-12']);
      await expect(service.calendarHolidays('2027-02-01', '2027-01-01')).rejects.toMatchObject({ response: { code: 'BAD_REQUEST' } });
    });

    it('les fériés fixes valent pour toute année (2028, 2099) ; Yennayer seulement à partir de 2018', async () => {
      const in2028 = await service.calendarHolidays('2028-01-01', '2028-12-31');
      expect(in2028.filter((h) => h.type === 'FIXE').map((h) => h.date)).toEqual(['2028-01-01', '2028-01-12', '2028-05-01', '2028-07-05', '2028-11-01']);
      expect((await service.calendarHolidays('2099-07-05', '2099-07-05')).map((h) => h.label)).toEqual(["Fête de l'indépendance"]);
      expect((await service.calendarHolidays('2017-01-01', '2017-01-31')).map((h) => h.label)).toEqual(["Jour de l'an"]);
      await expect(service.calendarHolidays('2000-01-01', '2099-12-31')).rejects.toMatchObject({ response: { code: 'BAD_REQUEST' } });
    });

    it('un férié prévisionnel se supprime', async () => {
      const h = await service.createHoliday({ date: '2026-08-26', kind: 'MAWLID_ENNABAOUI' }, operateur);
      await service.removeHoliday(h.id);
      expect(await service.listHolidays(2026)).toEqual([]);
    });
  });
});
