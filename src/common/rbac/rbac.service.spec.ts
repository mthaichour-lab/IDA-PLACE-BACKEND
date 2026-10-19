import { RbacService } from './rbac.service';

/**
 * Revue sécurité 2026-10-18 : `setMatrix` acceptait auparavant n'importe
 * quelle clé rôle/privilège et n'importe quelle valeur sans validation
 * (le `ValidationPipe` global ne s'applique qu'aux DTO de classe, pas au
 * type TS inline que prenait le contrôleur). Déjà gardé par
 * `@Privileges('admin')` (pas une escalade de privilège en soi), mais
 * c'est un point d'entrée non validé sur une config critique — testé ici
 * directement au niveau service, point d'entrée unique de la mutation.
 */
describe('RbacService.setMatrix — validation (revue sécurité 2026-10-18)', () => {
  let service: RbacService;

  beforeEach(() => {
    service = new RbacService();
  });

  it('refuse avec un 400 une clé de rôle inconnue', () => {
    expect(() => service.setMatrix({ ROLE_INVENTE: { admin: true } } as never)).toThrow();
    try {
      service.setMatrix({ ROLE_INVENTE: { admin: true } } as never);
    } catch (e) {
      expect((e as { response: { code: string } }).response.code).toBe('BAD_REQUEST');
    }
  });

  it('refuse avec un 400 une clé de privilège inconnue', () => {
    expect(() => service.setMatrix({ TRESORIER: { superAdminInvente: true } } as never)).toThrow();
  });

  it('refuse avec un 400 une valeur non booléenne', () => {
    expect(() => service.setMatrix({ TRESORIER: { pay: 'oui' } } as never)).toThrow();
  });

  it('accepte une mise à jour valide et la fusionne sans écraser les autres rôles (comportement inchangé)', () => {
    const before = service.getMatrix();
    expect(before.TRESORIER.bill).toBe(true);

    service.setMatrix({ CORRESPONDANT_IDA: { refedit: false } } as never);

    const after = service.getMatrix();
    expect(after.CORRESPONDANT_IDA.refedit).toBe(false);
    expect(after.CORRESPONDANT_IDA.matchDecide).toBe(true); // autre privilège du même rôle intact
    expect(after.TRESORIER.bill).toBe(true); // autre rôle totalement intact
  });
});

/**
 * SEC-25 (revue sécurité 2026-10-19) — plancher de séparation des tâches :
 * aucun privilège réservé à la place pour un rôle de compagnie.
 */
describe('RbacService — plancher des privilèges réservés à la place (SEC-25)', () => {
  let service: RbacService;

  beforeEach(() => {
    service = new RbacService();
  });

  it('refuse (400 PRIVILEGE_RESERVE_PLACE) de donner "decide" ou "closeQuarter" à un rôle compagnie via la matrice', () => {
    expect(() => service.setMatrix({ CORRESPONDANT_IDA: { decide: true } } as never)).toThrow();
    let code: string | undefined;
    try {
      service.setMatrix({ TRESORIER: { closeQuarter: true } } as never);
    } catch (e) {
      code = (e as { response: { code: string } }).response.code;
    }
    expect(code).toBe('PRIVILEGE_RESERVE_PLACE');
    expect(service.getMatrix().CORRESPONDANT_IDA.decide).toBe(false);
    expect(service.getMatrix().TRESORIER.closeQuarter).toBe(false);
  });

  it("accepte de RETIRER un privilège (false) à un rôle compagnie, et d'accorder un privilège réservé à un rôle de place", () => {
    expect(() => service.setMatrix({ CORRESPONDANT_IDA: { decide: false }, MEMBRE_COMMISSION: { seal: true } } as never)).not.toThrow();
    expect(service.getMatrix().MEMBRE_COMMISSION.seal).toBe(true);
  });

  it("un patch refusé n'applique AUCUNE partie de la modification (validation avant fusion)", () => {
    expect(() => service.setMatrix({ MEMBRE_COMMISSION: { seal: true }, TRESORIER: { sanction: true } } as never)).toThrow();
    expect(service.getMatrix().MEMBRE_COMMISSION.seal).toBe(false);
  });

  it('previewMatrixChange renvoie les changements effectifs sans les appliquer (journalisation)', () => {
    const changes = service.previewMatrixChange({ TRESORIER: { bill: false, pay: true } });
    expect(changes).toEqual([{ role: 'TRESORIER', privilege: 'bill', from: true, to: false }]);
    expect(service.getMatrix().TRESORIER.bill).toBe(true);
  });

  it('previewMatrixChange refuse un corps absent ou mal formé (400 et non 500)', () => {
    expect(() => service.previewMatrixChange(undefined)).toThrow();
    expect(() => service.previewMatrixChange([])).toThrow();
  });

  it('effectivePrivileges retire toute dérogation "grant" réservée à la place pour un rôle compagnie (défense en profondeur)', () => {
    const privileges = service.effectivePrivileges('TRESORIER', ['closeQuarter', 'decide', 'admin', 'remind']);
    expect(privileges).not.toContain('closeQuarter');
    expect(privileges).not.toContain('decide');
    expect(privileges).not.toContain('admin');
    expect(privileges).toContain('remind');
  });

  it('effectivePrivileges ignore un privilège inconnu en dérogation', () => {
    expect(service.effectivePrivileges('TRESORIER', ['inconnu' as never])).not.toContain('inconnu');
  });
});
