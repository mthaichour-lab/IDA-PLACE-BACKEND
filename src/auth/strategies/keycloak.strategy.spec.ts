import { createPublicKey, generateKeyPairSync, KeyObject } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { PlaceUserDirectory } from '../../common/directory/place-user-directory.service';
import { RbacService } from '../../common/rbac/rbac.service';
import { KeycloakStrategy } from './keycloak.strategy';

/** Double minimal — pas de conteneur Nest ici (voir `new KeycloakStrategy(...)` ci-dessous). */
function fakeDirectory(derogationsByEmail: Record<string, { grant: string[]; revoke: string[] } | null> = {}): PlaceUserDirectory {
  return {
    findActiveDerogationsByEmail: jest.fn(async (email: string) => derogationsByEmail[email] ?? null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const KID = 'test-key-1';
const ISSUER = 'http://keycloak.test/realms/ida-place';

function buildKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function jwkFromPublicKeyPem(publicKeyPem: string, kid: string) {
  const keyObject: KeyObject = createPublicKey(publicKeyPem);
  const jwk = keyObject.export({ format: 'jwk' }) as Record<string, unknown>;
  return { ...jwk, kid, alg: 'RS256', use: 'sig' };
}

function mockFetchJwks(jwks: { keys: unknown[] }): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', json: async () => jwks });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = fetchMock;
  return fetchMock;
}

function setKeycloakEnv(): void {
  process.env.KEYCLOAK_BASE_URL = 'http://keycloak.test';
  process.env.KEYCLOAK_REALM = 'ida-place';
  process.env.KEYCLOAK_CLIENT_ID = 'ida-place-api';
}

function clearKeycloakEnv(): void {
  delete process.env.KEYCLOAK_BASE_URL;
  delete process.env.KEYCLOAK_REALM;
  delete process.env.KEYCLOAK_CLIENT_ID;
}

describe('KeycloakStrategy', () => {
  let privateKeyPem: string;
  let publicKeyPem: string;
  let strategy: KeycloakStrategy;

  beforeAll(() => {
    const pair = buildKeyPair();
    privateKeyPem = pair.privateKey;
    publicKeyPem = pair.publicKey;
  });

  beforeEach(() => {
    setKeycloakEnv();
    strategy = new KeycloakStrategy(new RbacService(), fakeDirectory());
    mockFetchJwks({ keys: [jwkFromPublicKeyPem(publicKeyPem, KID)] });
  });

  afterEach(() => {
    clearKeycloakEnv();
    jest.restoreAllMocks();
  });

  function signToken(payload: Record<string, unknown>, overrides: jwt.SignOptions = {}): string {
    return jwt.sign(payload, privateKeyPem, {
      algorithm: 'RS256',
      keyid: KID,
      issuer: ISSUER,
      expiresIn: '1h',
      ...overrides,
    });
  }

  it('assertConfigured() lève une erreur explicite si KEYCLOAK_* manquent (zero-trust, pas de repli admin)', () => {
    clearKeycloakEnv();
    expect(() => strategy.assertConfigured()).toThrow(/configuration manquante/);
  });

  it("assertConfigured() ne lève rien si la config minimale est présente", () => {
    expect(() => strategy.assertConfigured()).not.toThrow();
  });

  it('résout un utilisateur authentifié à partir d’un JWT RS256 valide (JWKS mocké)', async () => {
    const token = signToken({
      sub: 'kc-user-1',
      email: 'operateur@finlab.dz',
      name: 'Opérateur Place',
      azp: 'ida-place-api',
      realm_access: { roles: ['OPERATEUR_PLACE'] },
    });

    const user = await strategy.resolve({ headers: { authorization: `Bearer ${token}` } });

    expect(user).not.toBeNull();
    expect(user?.id).toBe('kc-user-1');
    expect(user?.role).toBe('OPERATEUR_PLACE');
    expect(user?.email).toBe('operateur@finlab.dz');
    expect(user?.privileges.length).toBeGreaterThan(0);
  });

  it('mappe companyId depuis la claim custom company_id (CORRESPONDANT_IDA)', async () => {
    const token = signToken({
      sub: 'kc-user-2',
      email: 'correspondant@caat.dz',
      azp: 'ida-place-api',
      company_id: 'COMP-0001',
      realm_access: { roles: ['CORRESPONDANT_IDA'] },
    });

    const user = await strategy.resolve({ headers: { authorization: `Bearer ${token}` } });
    expect(user?.companyId).toBe('COMP-0001');
  });

  it('priorise la claim explicite ida_place_role sur realm_access.roles', async () => {
    const token = signToken({
      sub: 'kc-user-3',
      azp: 'ida-place-api',
      ida_place_role: 'AUDITEUR_CSA',
      realm_access: { roles: ['OPERATEUR_PLACE'] },
    });

    const user = await strategy.resolve({ headers: { authorization: `Bearer ${token}` } });
    expect(user?.role).toBe('AUDITEUR_CSA');
    expect(user?.privileges).toEqual([]); // AUDITEUR_CSA toujours lecture seule (B.7)
  });

  it('renvoie null sans en-tête Authorization', async () => {
    const user = await strategy.resolve({ headers: {} });
    expect(user).toBeNull();
  });

  it('renvoie null si aucun rôle applicatif reconnu', async () => {
    const token = signToken({ sub: 'kc-user-4', azp: 'ida-place-api', realm_access: { roles: ['ROLE_INCONNU'] } });
    const user = await strategy.resolve({ headers: { authorization: `Bearer ${token}` } });
    expect(user).toBeNull();
  });

  it('rejette un jeton signé avec une autre clé (signature invalide)', async () => {
    const otherPair = buildKeyPair();
    const token = jwt.sign(
      { sub: 'kc-user-5', azp: 'ida-place-api', realm_access: { roles: ['OPERATEUR_PLACE'] } },
      otherPair.privateKey,
      { algorithm: 'RS256', keyid: KID, issuer: ISSUER, expiresIn: '1h' },
    );
    const user = await strategy.resolve({ headers: { authorization: `Bearer ${token}` } });
    expect(user).toBeNull();
  });

  it('rejette un jeton émis pour un client inattendu', async () => {
    const token = signToken({ sub: 'kc-user-6', azp: 'autre-client', realm_access: { roles: ['OPERATEUR_PLACE'] } });
    const user = await strategy.resolve({ headers: { authorization: `Bearer ${token}` } });
    expect(user).toBeNull();
  });

  it('rejette un jeton avec un issuer différent', async () => {
    const token = signToken(
      { sub: 'kc-user-7', azp: 'ida-place-api', realm_access: { roles: ['OPERATEUR_PLACE'] } },
      { issuer: 'http://autre-serveur/realms/autre' },
    );
    const user = await strategy.resolve({ headers: { authorization: `Bearer ${token}` } });
    expect(user).toBeNull();
  });

  describe('dérogations grant/revoke par utilisateur (PlaceUserDirectory, B.7)', () => {
    it('applique les dérogations grant/revoke du PlaceUser correspondant à l’email du token', async () => {
      const directory = fakeDirectory({ 'correspondant@caat.dz': { grant: ['bill'], revoke: [] } });
      strategy = new KeycloakStrategy(new RbacService(), directory);
      const token = signToken({
        sub: 'kc-user-8',
        email: 'correspondant@caat.dz',
        azp: 'ida-place-api',
        realm_access: { roles: ['CORRESPONDANT_IDA'] },
      });

      const user = await strategy.resolve({ headers: { authorization: `Bearer ${token}` } });

      expect(directory.findActiveDerogationsByEmail).toHaveBeenCalledWith('correspondant@caat.dz');
      expect(user?.privileges).toContain('bill');
    });

    it('retire un privilège via une dérogation "revoke" malgré le rôle', async () => {
      const directory = fakeDirectory({ 'operateur@finlab.dz': { grant: [], revoke: ['bill'] } });
      strategy = new KeycloakStrategy(new RbacService(), directory);
      const token = signToken({
        sub: 'kc-user-9',
        email: 'operateur@finlab.dz',
        azp: 'ida-place-api',
        realm_access: { roles: ['OPERATEUR_PLACE'] },
      });

      const user = await strategy.resolve({ headers: { authorization: `Bearer ${token}` } });
      expect(user?.privileges).not.toContain('bill');
    });

    it('applique le rôle seul (aucune dérogation) si aucun PlaceUser ne correspond à cet email — miroir non synchronisé', async () => {
      const directory = fakeDirectory({});
      strategy = new KeycloakStrategy(new RbacService(), directory);
      const token = signToken({
        sub: 'kc-user-10',
        email: 'inconnu@ailleurs.dz',
        azp: 'ida-place-api',
        realm_access: { roles: ['OPERATEUR_PLACE'] },
      });

      const user = await strategy.resolve({ headers: { authorization: `Bearer ${token}` } });
      expect(user).not.toBeNull();
      expect(directory.findActiveDerogationsByEmail).toHaveBeenCalledWith('inconnu@ailleurs.dz');
    });

    it('applique le rôle seul (aucune dérogation) si le PlaceUser correspondant est suspendu — pas de rejet total', async () => {
      // PlaceUserDirectory.findActiveDerogationsByEmail renvoie null pour un compte suspendu (voir son implémentation) :
      // simulé ici directement, Keycloak reste la source de vérité pour l'authentification elle-même.
      const directory = fakeDirectory({ 'suspendu@caat.dz': null });
      strategy = new KeycloakStrategy(new RbacService(), directory);
      const token = signToken({
        sub: 'kc-user-11',
        email: 'suspendu@caat.dz',
        azp: 'ida-place-api',
        realm_access: { roles: ['CORRESPONDANT_IDA'] },
      });

      const user = await strategy.resolve({ headers: { authorization: `Bearer ${token}` } });
      expect(user).not.toBeNull();
      expect(user?.role).toBe('CORRESPONDANT_IDA');
    });
  });
});
