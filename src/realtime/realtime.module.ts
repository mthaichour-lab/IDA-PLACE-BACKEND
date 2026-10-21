import { EventEmitter } from 'events';
import { RequestContext } from '@mikro-orm/core';
import { InjectRepository, MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { isProductionEnv } from '../common/config/env.validation';
import { PlaceUser } from '../common/directory/place-user.entity';
import { AUTH_PROVIDER, AuthenticatedUser, AuthProvider } from '../common/interfaces/authenticated-user.interface';
import { sanitizeForLog } from '../common/logging/sanitize-log';
import { isCompanyScopedRole, PLACE_LEVEL_ROLES } from '../common/rbac/roles-privileges';

export type RealtimeEvent = 'claim.ingested' | 'match.updated' | 'recours.timer' | 'metering.tick' | 'ledger.appended';

/** Salon réservé aux rôles de place (SEC-07). */
export const PLACE_ROOM = 'tenant:place';
/** Salon d'une compagnie adhérente (SEC-07). */
export const tenantRoom = (companyCode: string): string => `tenant:${companyCode}`;

export interface EmitOptions {
  /** Salons destinataires ; `PLACE_ROOM` par défaut. */
  rooms?: string | string[];
  /** Payload relayé aux abonnés internes (`onEvent`) ; `payload` par défaut. */
  internalPayload?: unknown;
}

/** Délai maximal d'un `setTimeout` Node (≈ 24,8 jours) — au-delà, le minuteur se déclencherait immédiatement. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * RealtimeModule — B.2/B.12 : passerelle WebSocket pour les dashboards
 * temps réel (écrans 1, 2, 10).
 *
 * SEC-01/SEC-07 (revue sécurité 2026-10-19) :
 *  - authentification au handshake par `handshake.auth.token` (jeton Bearer
 *    Keycloak, transmis au `AuthProvider` actif comme un en-tête
 *    `Authorization`) ; l'identité de développement `handshake.auth.devUser`
 *    n'est lue que hors production (`NODE_ENV !== 'production'`) ;
 *  - salons : seuls les rôles de place (`PLACE_LEVEL_ROLES`) rejoignent
 *    `PLACE_ROOM` ; un rôle compagnie ne rejoint QUE `tenantRoom(companyId)`
 *    (connexion refusée s'il n'a pas de compagnie) — auparavant, tout
 *    utilisateur authentifié rejoignait `tenant:place` et recevait l'activité
 *    de toutes les compagnies ;
 *  - CORS : le décorateur porte une valeur FERMÉE (`origin: false`) ; la liste
 *    d'origines autorisées (`CORS_ORIGIN`, jamais `*`) est appliquée par
 *    `RealtimeIoAdapter` dans `configureApp` (auparavant
 *    `process.env.CORS_ORIGIN ?? '*'` était lu au chargement du module, avant
 *    `ConfigModule`) ;
 *  - déconnexion à l'expiration du jeton (`AuthenticatedUser.expiresAt`) : le
 *    client se reconnecte avec un jeton renouvelé.
 *
 * Les émetteurs (ClaimsModule, MatchingModule…) appellent
 * `emitEvent(event, payload, { rooms, internalPayload })` : payload WebSocket
 * minimal vers les seules compagnies parties + `PLACE_ROOM`, payload complet
 * aux abonnés internes (`onEvent`, ex. FraudModule).
 *
 * TODO(backend-agent): file d'événements Redis (pub/sub) pour supporter
 * plusieurs instances du back-end (voir HANDOFF.md §4).
 */
@Injectable()
@WebSocketGateway({ cors: { origin: false }, namespace: '/realtime' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger('RealtimeGateway');
  private readonly internalEmitter = new EventEmitter();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(AUTH_PROVIDER) private readonly authProvider: AuthProvider,
    // Seulement pour son `EntityManager` (voir `handleConnection` : un
    // handshake WebSocket n'est pas une requête HTTP, aucun `RequestContext`
    // MikroORM n'y est donc établi par Nest — même motif que
    // `FraudService.recompute`/`RecoursService.sweep`, hors requête HTTP).
    @InjectRepository(PlaceUser) private readonly placeUserRepo: EntityRepository<PlaceUser>,
  ) {
    // Beaucoup d'abonnés internes possibles (Fraud, futurs modules) — évite
    // le warning MaxListenersExceeded par défaut (10) de Node.
    this.internalEmitter.setMaxListeners(50);
  }

  /** En-têtes synthétiques passés au `AuthProvider` (même interface que l'API REST). */
  private handshakeHeaders(client: Socket): Record<string, unknown> {
    const auth = (client.handshake.auth ?? {}) as { devUser?: unknown; token?: unknown };
    const headers: Record<string, unknown> = {};
    const authorization = client.handshake.headers?.authorization;
    if (typeof authorization === 'string') headers['authorization'] = authorization;
    if (typeof auth.token === 'string' && auth.token.length > 0) {
      headers['authorization'] = `Bearer ${auth.token.replace(/^Bearer\s+/i, '')}`;
    }
    if (!isProductionEnv()) {
      // Développement uniquement : un navigateur ne peut pas poser l'en-tête
      // `x-dev-user` sur un handshake WebSocket, le client passe donc
      // l'identité de démonstration dans `auth.devUser` (ou l'en-tête, pour
      // curl/Node). Jamais lu en production (SEC-01).
      const devHeader = client.handshake.headers?.['x-dev-user'];
      if (auth.devUser !== undefined) {
        headers['x-dev-user'] = typeof auth.devUser === 'string' ? auth.devUser : JSON.stringify(auth.devUser);
      } else if (typeof devHeader === 'string') {
        headers['x-dev-user'] = devHeader;
      }
    }
    return headers;
  }

  private reject(client: Socket, code: string, message: string): void {
    client.emit('error', { code, message });
    client.disconnect(true);
  }

  async handleConnection(client: Socket): Promise<void> {
    // `RequestContext.create` : voir le commentaire du constructeur — sans
    // lui, `this.authProvider.resolve` (→ `PlaceUserDirectory.lookupAccount`,
    // un repo MikroORM) utiliserait l'`EntityManager` global et lèverait
    // "Using global EntityManager instance methods…", refusant TOUTE
    // connexion WS en mode Keycloak (fail closed — jamais observé en mode
    // dev, où `DevAuthProvider` ne touche pas la base).
    await RequestContext.create(this.placeUserRepo.getEntityManager(), () => this.authenticateAndJoin(client));
  }

  private async authenticateAndJoin(client: Socket): Promise<void> {
    let user: AuthenticatedUser | null = null;
    try {
      user = await this.authProvider.resolve({ headers: this.handshakeHeaders(client) });
    } catch (err) {
      // Ex. 503 base injoignable en production pendant la vérification du compte : refus (fail closed).
      this.logger.warn(`Connexion WS refusée (vérification d'identité impossible) : ${sanitizeForLog(err)}`);
    }
    if (!user) {
      this.logger.warn(`Connexion WS refusée (non authentifiée): ${client.id}`);
      this.reject(client, 'UNAUTHORIZED', 'Authentification requise (jeton Bearer dans handshake.auth.token).');
      return;
    }

    const now = Date.now();
    if (user.expiresAt !== undefined && user.expiresAt <= now) {
      this.reject(client, 'UNAUTHORIZED', 'Jeton expiré.');
      return;
    }

    const rooms = realtimeRoomsFor(user);
    if (rooms.length === 0) {
      this.logger.warn(`Connexion WS refusée : rôle ${user.role} sans compagnie de rattachement (${client.id}).`);
      this.reject(client, 'FORBIDDEN', 'Utilisateur rattaché à une compagnie mais sans companyId.');
      return;
    }
    await client.join(rooms);

    if (user.expiresAt !== undefined) {
      const timer = setTimeout(() => {
        this.expiryTimers.delete(client.id);
        this.reject(client, 'TOKEN_EXPIRED', 'Jeton expiré : reconnectez-vous avec un jeton renouvelé.');
      }, Math.min(user.expiresAt - now, MAX_TIMER_MS));
      timer.unref?.();
      this.expiryTimers.set(client.id, timer);
    }
    this.logger.log(`Client connecté: ${client.id} (${user.role} → ${sanitizeForLog(rooms.join(','), 80)})`);
  }

  handleDisconnect(client: Socket): void {
    const timer = this.expiryTimers.get(client.id);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(client.id);
    }
    this.logger.log(`Client déconnecté: ${client.id}`);
  }

  /**
   * Diffuse `payload` aux salons `opts.rooms` (par défaut le seul salon de
   * place) et relaie `opts.internalPayload ?? payload` aux abonnés internes.
   * SEC-07 : le payload WebSocket doit rester minimal (`{ id, état }`, sans
   * donnée nominative) et viser les seules compagnies parties
   * (`tenantRoom(code)`) plus `PLACE_ROOM` ; les abonnés internes (Fraud…)
   * reçoivent le payload complet via `internalPayload`.
   */
  emitEvent(event: RealtimeEvent, payload: unknown, opts: string | EmitOptions = {}): void {
    const { rooms = PLACE_ROOM, internalPayload = payload } = typeof opts === 'string' ? { rooms: opts } : opts;
    this.server?.to(rooms).emit(event, payload);
    this.internalEmitter.emit(event, internalPayload);
  }

  /** Abonnement interne (process local) à un événement de place — voir doc de classe. */
  onEvent(event: RealtimeEvent, handler: (payload: unknown) => void): void {
    this.internalEmitter.on(event, handler);
  }
}

/**
 * SEC-07 — salons d'un utilisateur : rôles de place → `PLACE_ROOM` seul ;
 * rôles compagnie → `tenantRoom(companyId)` seul (aucun salon si la
 * compagnie manque : la connexion est alors refusée).
 */
export function realtimeRoomsFor(user: Pick<AuthenticatedUser, 'role' | 'companyId'>): string[] {
  if (isCompanyScopedRole(user.role)) return user.companyId ? [tenantRoom(user.companyId)] : [];
  if ((PLACE_LEVEL_ROLES as readonly string[]).includes(user.role)) return [PLACE_ROOM];
  return [];
}

@Module({ imports: [MikroOrmModule.forFeature([PlaceUser])], providers: [RealtimeGateway], exports: [RealtimeGateway] })
export class RealtimeModule {}
