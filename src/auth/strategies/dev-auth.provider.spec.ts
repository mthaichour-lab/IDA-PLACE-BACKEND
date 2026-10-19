import { Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { EXAMPLE_DEV_JWT_SECRET, getDevJwtSecret } from '../../common/config/env.validation';
import { RbacService } from '../../common/rbac/rbac.service';
import { DevAuthProvider } from './dev-auth.provider';

/** SEC-01 / SEC-45 — fournisseur d'authentification de développement. */
describe('DevAuthProvider', () => {
  const originalEnv = { NODE_ENV: process.env.NODE_ENV, DEV_JWT_SECRET: process.env.DEV_JWT_SECRET };
  let provider: DevAuthProvider;

  beforeEach(() => {
    provider = new DevAuthProvider(new RbacService());
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    if (originalEnv.DEV_JWT_SECRET === undefined) delete process.env.DEV_JWT_SECRET;
    else process.env.DEV_JWT_SECRET = originalEnv.DEV_JWT_SECRET;
    jest.restoreAllMocks();
  });

  it('résout un utilisateur de démonstration hors production', async () => {
    const user = await provider.resolve({ headers: { 'x-dev-user': 'ADMIN_UAR' } });
    expect(user?.role).toBe('ADMIN_UAR');
  });

  it('SEC-01 : NODE_ENV=production → aucune identité, même avec x-dev-user (défense en profondeur)', async () => {
    process.env.NODE_ENV = 'production';
    expect(await provider.resolve({ headers: { 'x-dev-user': 'ADMIN_UAR' } })).toBeNull();
    expect(await provider.resolve({ headers: { 'x-dev-user': '{"role":"TRESORIER","companyId":"SAA","grant":["closeQuarter"]}' } })).toBeNull();
  });

  it('SEC-01 : un jeton signé avec la valeur publique de .env.example est refusé (plus de repli)', async () => {
    process.env.DEV_JWT_SECRET = EXAMPLE_DEV_JWT_SECRET;
    const forged = jwt.sign({ id: 'x', name: 'x', email: 'x@x', role: 'ADMIN_UAR' }, EXAMPLE_DEV_JWT_SECRET);
    expect(await provider.resolve({ headers: { authorization: `Bearer ${forged}` } })).toBeNull();
  });

  it('accepte un jeton signé avec le secret configuré et expose son expiration', async () => {
    const token = jwt.sign({ id: 'u', name: 'U', email: 'u@x', role: 'OPERATEUR_PLACE' }, getDevJwtSecret(), { expiresIn: 60 });
    const user = await provider.resolve({ headers: { authorization: `Bearer ${token}` } });
    expect(user?.role).toBe('OPERATEUR_PLACE');
    expect(user?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('SEC-25 : un en-tête JSON accordant un privilège réservé à la place à un rôle compagnie reste sans effet', async () => {
    const user = await provider.resolve({ headers: { 'x-dev-user': '{"id":"t","name":"T","email":"t@saa.dz","role":"TRESORIER","companyId":"SAA","grant":["closeQuarter","decide"]}' } });
    expect(user?.privileges).not.toContain('closeQuarter');
    expect(user?.privileges).not.toContain('decide');
  });

  it('SEC-45 : un en-tête illisible contenant des retours à la ligne produit UNE seule ligne de journal', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await provider.resolve({ headers: { 'x-dev-user': 'pas-un-role\n2026-10-19 LOG [Auth] connexion ADMIN_UAR réussie' } })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('\n');
  });

  it('refuse un en-tête démesuré', async () => {
    expect(await provider.resolve({ headers: { 'x-dev-user': `{"role":"ADMIN_UAR","pad":"${'x'.repeat(5000)}"}` } })).toBeNull();
  });
});
