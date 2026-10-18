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
