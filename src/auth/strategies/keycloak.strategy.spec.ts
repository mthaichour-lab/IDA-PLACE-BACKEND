import { createPublicKey, generateKeyPairSync, KeyObject } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { PlaceUserAccountLookup, PlaceUserDirectory } from '../../common/directory/place-user-directory.service';
import { RbacService } from '../../common/rbac/rbac.service';
import { JWKS_REQUESTS_PER_MINUTE, KeycloakStrategy } from './keycloak.strategy';

/** Double minimal de l'annuaire — pas de conteneur Nest ici. */
function fakeDirectory(accountsBySub: Record<string, PlaceUserAccountLookup> = {}): PlaceUserDirectory {
  return {
    lookupAccount: jest.fn(async ({ sub }: { sub: string }) => accountsBySub[sub] ?? { status: 'UNKNOWN' }),
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

const KEYCLOAK_ENV = ['KEYCLOAK_BASE_URL', 'KEYCLOAK_REALM', 'KEYCLOAK_CLIENT_ID', 'KEYCLOAK_ALLOWED_CLIENTS'];

function setKeycloakEnv(): void {
  process.env.KEYCLOAK_BASE_URL = 'http://keycloak.test';
  process.env.KEYCLOAK_REALM = 'ida-place';
  process.env.KEYCLOAK_CLIENT_ID = 'ida-place-api';
  process.env.KEYCLOAK_ALLOWED_CLIENTS = 'ida-place-web,ida-place-api';
}

function clearKeycloakEnv(): void {
  for (const k of KEYCLOAK_ENV) delete process.env[k];
}

/** Charge utile d'un jeton d'accès Keycloak valide (typ Bearer, client autorisé, e-mail vérifié). */
function accessToken(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'kc-user-1',
    typ: 'Bearer',
    azp: 'ida-place-web',
    email: 'operateur@finlab.dz',
    email_verified: true,
    name: 'Opérateur Place',
    realm_access: { roles: ['OPERATEUR_PLACE'] },
    ...overrides,
  };
}

describe('KeycloakStrategy', () => {
  let privateKeyPem: string;
  let publicKeyPem: string;
  let strategy: KeycloakStrategy;
  let fetchMock: jest.Mock;

  beforeAll(() => {
    const pair = buildKeyPair();
    privateKeyPem = pair.privateKey;
    publicKeyPem = pair.publicKey;
  });

  beforeEach(() => {
    setKeycloakEnv();
    strategy = new KeycloakStrategy(new RbacService(), fakeDirectory());
    fetchMock = mockFetchJwks({ keys: [jwkFromPublicKeyPem(publicKeyPem, KID)] });
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

  const resolve = (token: string) => strategy.resolve({ headers: { authorization: `Bearer ${token}` } });

  it('assertConfigured() lève une erreur explicite si KEYCLOAK_* manquent (zero-trust, pas de repli admin)', () => {
    clearKeycloakEnv();
    expect(() => strategy.assertConfigured()).toThrow(/configuration manquante/);
  });

  it("assertConfigured() ne lève rien si la config minimale est présente", () => {
    expect(() => strategy.assertConfigured()).not.toThrow();
  });

  it('résout un utilisateur authentifié à partir d’un JWT RS256 valide (JWKS mocké)', async () => {
    const user = await resolve(signToken(accessToken()));
    expect(user).not.toBeNull();
    expect(user?.id).toBe('kc-user-1');
    expect(user?.role).toBe('OPERATEUR_PLACE');
    expect(user?.email).toBe('operateur@finlab.dz');
    expect(user?.privileges.length).toBeGreaterThan(0);
    expect(user?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('mappe companyId depuis la claim custom company_id (CORRESPONDANT_IDA)', async () => {
    const user = await resolve(signToken(accessToken({ company_id: 'CAAT', realm_access: { roles: ['CORRESPONDANT_IDA'] } })));
    expect(user?.companyId).toBe('CAAT');
  });

  it('séparation place / compagnies : rôle compagnie sans company_id rejeté', async () => {
    expect(await resolve(signToken(accessToken({ realm_access: { roles: ['CORRESPONDANT_IDA'] } })))).toBeNull();
  });

  it('séparation place / compagnies : rôle de la place porteur d’un company_id rejeté', async () => {
    expect(await resolve(signToken(accessToken({ company_id: 'CAAR', realm_access: { roles: ['OPERATEUR_PLACE'] } })))).toBeNull();
    expect(await resolve(signToken(accessToken({ company_id: 'CAAR', realm_access: { roles: ['ADMIN_UAR'] } })))).toBeNull();
  });

  it('priorise la claim explicite ida_place_role sur realm_access.roles', async () => {
    const user = await resolve(signToken(accessToken({ ida_place_role: 'AUDITEUR_CSA', realm_access: { roles: ['OPERATEUR_PLACE'] } })));
    expect(user?.role).toBe('AUDITEUR_CSA');
    expect(user?.privileges).toEqual([]); // AUDITEUR_CSA toujours lecture seule (B.7)
  });

  it('renvoie null sans en-tête Authorization', async () => {
    expect(await strategy.resolve({ headers: {} })).toBeNull();
  });

  it('renvoie null si aucun rôle applicatif reconnu', async () => {
    expect(await resolve(signToken(accessToken({ realm_access: { roles: ['ROLE_INCONNU'] } })))).toBeNull();
  });

  it('rejette un jeton signé avec une autre clé (signature invalide)', async () => {
    const otherPair = buildKeyPair();
    const token = jwt.sign(accessToken(), otherPair.privateKey, { algorithm: 'RS256', keyid: KID, issuer: ISSUER, expiresIn: '1h' });
    expect(await resolve(token)).toBeNull();
  });

  it('rejette un jeton émis pour un client inattendu', async () => {
    expect(await resolve(signToken(accessToken({ azp: 'autre-client' })))).toBeNull();
  });

  it('rejette un jeton avec un issuer différent', async () => {
    expect(await resolve(signToken(accessToken(), { issuer: 'http://autre-serveur/realms/autre' }))).toBeNull();
  });

  it('rejette un jeton expiré', async () => {
    expect(await resolve(signToken(accessToken(), { expiresIn: -10 }))).toBeNull();
  });

  describe('durcissement SEC-24', () => {
    it('rejette un jeton sans azp ni aud (client obligatoire)', async () => {
      const payload = accessToken();
      delete payload.azp;
      expect(await resolve(signToken(payload))).toBeNull();
    });

    it('accepte un jeton sans azp dont aud contient un client autorisé', async () => {
      const payload = accessToken({ aud: ['account', 'ida-place-api'] });
      delete payload.azp;
      expect(await resolve(signToken(payload))).not.toBeNull();
    });

    it('la liste des clients vient de la configuration (plus de clients codés en dur)', async () => {
      process.env.KEYCLOAK_ALLOWED_CLIENTS = 'ida-place-api';
      expect(await resolve(signToken(accessToken({ azp: 'ida-place-web' })))).toBeNull();
    });

    it('rejette un jeton dont typ n’est pas "Bearer" (ID token, refresh token)', async () => {
      expect(await resolve(signToken(accessToken({ typ: 'ID' })))).toBeNull();
      const noTyp = accessToken();
      delete noTyp.typ;
      expect(await resolve(signToken(noTyp))).toBeNull();
    });

    it('rejette un jeton portant plusieurs rôles applicatifs (plus de choix arbitraire)', async () => {
      expect(await resolve(signToken(accessToken({ realm_access: { roles: ['CORRESPONDANT_IDA', 'ADMIN_UAR'] } })))).toBeNull();
    });

    it('rejette une claim ida_place_role inconnue (pas de repli sur realm_access)', async () => {
      expect(await resolve(signToken(accessToken({ ida_place_role: 'SUPER_ADMIN' })))).toBeNull();
    });

    it('rejette un jeton dont l’e-mail n’est pas vérifié', async () => {
      expect(await resolve(signToken(accessToken({ email_verified: false })))).toBeNull();
      const noFlag = accessToken();
      delete noFlag.email_verified;
      expect(await resolve(signToken(noFlag))).toBeNull();
    });

    it('rejette un algorithme autre que RS256 avant tout appel JWKS', async () => {
      const token = jwt.sign(accessToken(), 'secret-symetrique', { algorithm: 'HS256', keyid: KID, issuer: ISSUER });
      expect(await resolve(token)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejette un kid malformé (retour à la ligne) sans appeler le JWKS', async () => {
      const token = jwt.sign(accessToken(), privateKeyPem, { algorithm: 'RS256', keyid: 'kid\ninjecté', issuer: ISSUER });
      expect(await resolve(token)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('1 000 kid inconnus déclenchent au plus quelques appels JWKS (cache + limite de débit)', async () => {
      // Jetons forgés sans signature valide : le kid est lu AVANT toute vérification, seul compte l'appel JWKS.
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const body = b64({ ...accessToken(), iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
      for (let i = 0; i < 1000; i++) {
        const token = `${b64({ alg: 'RS256', typ: 'JWT', kid: `inconnu-${i}` })}.${body}.c2lnbmF0dXJl`;
        expect(await resolve(token)).toBeNull();
      }
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(JWKS_REQUESTS_PER_MINUTE);
    });

    it('met en cache la clé d’un kid connu (un seul appel JWKS pour 20 requêtes)', async () => {
      const token = signToken(accessToken());
      for (let i = 0; i < 20; i++) expect(await resolve(token)).not.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('compte applicatif PlaceUser (SEC-09)', () => {
    it('applique les dérogations grant/revoke d’un compte ACTIF', async () => {
      const directory = fakeDirectory({ 'kc-user-8': { status: 'ACTIVE', userId: 'u8', grant: ['bill'], revoke: [] } });
      strategy = new KeycloakStrategy(new RbacService(), directory);
      const user = await resolve(signToken(accessToken({ sub: 'kc-user-8', email: 'c@caat.dz', company_id: 'CAAT', realm_access: { roles: ['CORRESPONDANT_IDA'] } })));
      expect(directory.lookupAccount).toHaveBeenCalledWith({ sub: 'kc-user-8', email: 'c@caat.dz', emailVerified: true });
      expect(user?.privileges).toContain('bill');
    });

    it('applique un "revoke" à chaque requête malgré le rôle', async () => {
      const directory = fakeDirectory({ 'kc-user-9': { status: 'ACTIVE', userId: 'u9', grant: [], revoke: ['bill'] } });
      strategy = new KeycloakStrategy(new RbacService(), directory);
      const user = await resolve(signToken(accessToken({ sub: 'kc-user-9' })));
      expect(user?.privileges).not.toContain('bill');
    });

    it('refuse (401) un utilisateur SUSPENDU même avec un jeton valide', async () => {
      const directory = fakeDirectory({ 'kc-user-11': { status: 'INACTIVE', userId: 'u11' } });
      strategy = new KeycloakStrategy(new RbacService(), directory);
      expect(await resolve(signToken(accessToken({ sub: 'kc-user-11' })))).toBeNull();
    });

    it('refuse un jeton dont l’e-mail correspond à un compte lié à un AUTRE sub', async () => {
      const directory = fakeDirectory({ 'kc-intrus': { status: 'SUB_MISMATCH', userId: 'u12' } });
      strategy = new KeycloakStrategy(new RbacService(), directory);
      expect(await resolve(signToken(accessToken({ sub: 'kc-intrus' })))).toBeNull();
    });

    it('applique le rôle seul si aucun compte ne correspond (miroir non synchronisé)', async () => {
      const user = await resolve(signToken(accessToken({ sub: 'kc-user-10', email: 'inconnu@ailleurs.dz' })));
      expect(user).not.toBeNull();
      expect(user?.role).toBe('OPERATEUR_PLACE');
    });

    it('un grant réservé à la place reste sans effet pour un rôle compagnie (plancher SEC-25)', async () => {
      const directory = fakeDirectory({ 'kc-user-13': { status: 'ACTIVE', userId: 'u13', grant: ['decide', 'closeQuarter'], revoke: [] } });
      strategy = new KeycloakStrategy(new RbacService(), directory);
      const user = await resolve(signToken(accessToken({ sub: 'kc-user-13', company_id: 'SAA', realm_access: { roles: ['TRESORIER'] } })));
      expect(user?.privileges).not.toContain('decide');
      expect(user?.privileges).not.toContain('closeQuarter');
    });
  });
});
