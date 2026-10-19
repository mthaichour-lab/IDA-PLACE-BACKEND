import { AuthenticatedUser, AuthProvider } from '../common/interfaces/authenticated-user.interface';
import { PLACE_ROOM, RealtimeGateway, realtimeRoomsFor, tenantRoom } from './realtime.module';

function fakeSocket(auth: Record<string, unknown> = {}, headers: Record<string, unknown> = {}) {
  return {
    id: `sock-${Math.random().toString(36).slice(2)}`,
    handshake: { auth, headers },
    join: jest.fn(async () => undefined),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

function providerReturning(user: AuthenticatedUser | null): AuthProvider & { resolve: jest.Mock } {
  return { resolve: jest.fn(async () => user) };
}

const placeUser: AuthenticatedUser = { id: 'p', name: 'P', email: 'p@x', role: 'OPERATEUR_PLACE', privileges: [] };
const caat: AuthenticatedUser = { id: 'c', name: 'C', email: 'c@x', role: 'CORRESPONDANT_IDA', companyId: 'CAAT', privileges: [] };

/** SEC-01 / SEC-07 — passerelle temps réel. */
describe('RealtimeGateway', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.useRealTimers();
  });

  describe('realtimeRoomsFor (SEC-07)', () => {
    it('rôles de place → PLACE_ROOM uniquement', () => {
      for (const role of ['OPERATEUR_PLACE', 'ADMIN_UAR', 'MEMBRE_COMMISSION', 'AUDITEUR_CSA'] as const) {
        expect(realtimeRoomsFor({ role })).toEqual([PLACE_ROOM]);
      }
    });

    it('rôle compagnie → salon de SA compagnie uniquement, jamais PLACE_ROOM', () => {
      expect(realtimeRoomsFor({ role: 'CORRESPONDANT_IDA', companyId: 'CAAT' })).toEqual([tenantRoom('CAAT')]);
      expect(realtimeRoomsFor({ role: 'TRESORIER', companyId: 'SAA' })).toEqual([tenantRoom('SAA')]);
    });

    it('rôle compagnie sans compagnie → aucun salon', () => {
      expect(realtimeRoomsFor({ role: 'TRESORIER' })).toEqual([]);
    });
  });

  it('un rôle compagnie rejoint seulement tenant:<code>', async () => {
    const gateway = new RealtimeGateway(providerReturning(caat));
    const socket = fakeSocket({ token: 'jeton' });
    await gateway.handleConnection(socket as never);
    expect(socket.join).toHaveBeenCalledWith([tenantRoom('CAAT')]);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('refuse une connexion non authentifiée', async () => {
    const gateway = new RealtimeGateway(providerReturning(null));
    const socket = fakeSocket();
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('refuse un rôle compagnie sans companyId', async () => {
    const gateway = new RealtimeGateway(providerReturning({ ...caat, companyId: undefined }));
    const socket = fakeSocket({ token: 'jeton' });
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('transmet handshake.auth.token au fournisseur comme en-tête Authorization Bearer', async () => {
    const provider = providerReturning(placeUser);
    await new RealtimeGateway(provider).handleConnection(fakeSocket({ token: 'abc.def.ghi' }) as never);
    expect(provider.resolve).toHaveBeenCalledWith({ headers: { authorization: 'Bearer abc.def.ghi' } });
  });

  it('SEC-01 : hors production, devUser est transmis (développement)', async () => {
    process.env.NODE_ENV = 'development';
    const provider = providerReturning(placeUser);
    await new RealtimeGateway(provider).handleConnection(fakeSocket({ devUser: 'ADMIN_UAR' }) as never);
    expect(provider.resolve).toHaveBeenCalledWith({ headers: { 'x-dev-user': 'ADMIN_UAR' } });
  });

  it('SEC-01 : en production, devUser et l’en-tête x-dev-user du handshake sont ignorés', async () => {
    process.env.NODE_ENV = 'production';
    const provider = providerReturning(null);
    const socket = fakeSocket({ devUser: 'ADMIN_UAR' }, { 'x-dev-user': 'ADMIN_UAR' });
    await new RealtimeGateway(provider).handleConnection(socket as never);
    expect(provider.resolve).toHaveBeenCalledWith({ headers: {} });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('refuse (fail closed) si la résolution d’identité échoue (ex. 503 base injoignable)', async () => {
    const provider = { resolve: jest.fn(async () => Promise.reject(new Error('503'))) };
    const socket = fakeSocket({ token: 't' });
    await new RealtimeGateway(provider).handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('SEC-07 : déconnecte le client à l’expiration du jeton', async () => {
    jest.useFakeTimers();
    const gateway = new RealtimeGateway(providerReturning({ ...placeUser, expiresAt: Date.now() + 5_000 }));
    const socket = fakeSocket({ token: 't' });
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(5_001);
    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('refuse un jeton déjà expiré, et annule le minuteur à la déconnexion', async () => {
    jest.useFakeTimers();
    const expired = fakeSocket({ token: 't' });
    await new RealtimeGateway(providerReturning({ ...placeUser, expiresAt: Date.now() - 1 })).handleConnection(expired as never);
    expect(expired.disconnect).toHaveBeenCalledWith(true);

    const gateway = new RealtimeGateway(providerReturning({ ...placeUser, expiresAt: Date.now() + 5_000 }));
    const socket = fakeSocket({ token: 't' });
    await gateway.handleConnection(socket as never);
    gateway.handleDisconnect(socket as never);
    jest.advanceTimersByTime(10_000);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('emitEvent : contrat inchangé (salons explicites, PLACE_ROOM par défaut, payload interne)', () => {
    const gateway = new RealtimeGateway(providerReturning(null));
    const emit = jest.fn();
    gateway.server = { to: jest.fn(() => ({ emit })) } as never;
    const internal = jest.fn();
    gateway.onEvent('match.updated', internal);

    gateway.emitEvent('match.updated', { id: 'm1' }, { rooms: [tenantRoom('SAA'), PLACE_ROOM], internalPayload: { id: 'm1', plate: 'X' } });
    expect(gateway.server.to).toHaveBeenCalledWith([tenantRoom('SAA'), PLACE_ROOM]);
    expect(emit).toHaveBeenCalledWith('match.updated', { id: 'm1' });
    expect(internal).toHaveBeenCalledWith({ id: 'm1', plate: 'X' });

    gateway.emitEvent('claim.ingested', { id: 'c1' });
    expect(gateway.server.to).toHaveBeenLastCalledWith(PLACE_ROOM);
  });
});
