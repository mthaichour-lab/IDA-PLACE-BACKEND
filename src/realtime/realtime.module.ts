import { EventEmitter } from 'events';
import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AUTH_PROVIDER, AuthProvider } from '../common/interfaces/authenticated-user.interface';

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

/**
 * RealtimeModule — B.2/B.12 : passerelle WebSocket pour les dashboards
 * temps réel (écrans 1, 2, 10). Abonnement par salon tenant
 * (room `tenant:place` pour les événements de place — cockpit, matching,
 * métrologie — et, en plus, `tenant:<companyId>` pour un utilisateur
 * rattaché à une compagnie, afin de supporter de futurs événements scopés
 * compagnie comme `recours.timer`).
 *
 * Authentification de la connexion (B.12) : le handshake doit porter le
 * même en-tête `x-dev-user` que l'API REST (voir `DevAuthProvider`) — une
 * connexion non authentifiée est refusée (`disconnect`). `ClaimsModule`
 * (après import) et `MatchingModule` (après `decide()`) émettent
 * respectivement `claim.ingested` et `match.updated` via
 * `emitEvent(...)` (voir leurs services) — ce gateway ne contient plus de
 * logique métier propre, uniquement la diffusion.
 *
 * TODO(backend-agent): remplacer l'émission directe en mémoire par une file
 * d'événements Redis (pub/sub) pour supporter plusieurs instances du
 * back-end (voir HANDOFF.md §4).
 *
 * Sprint 3 (MonitoringModule/FraudModule) : en plus de la diffusion WebSocket,
 * `emitEvent` relaie désormais aussi chaque événement sur un `EventEmitter`
 * interne (`onEvent`), pour que d'autres modules RÉELS du même process
 * (ex. `FraudModule` — journal des actions suspectes, appariement manuel/
 * déliage/reliage) puissent réagir à `match.updated` sans dépendre de
 * Socket.IO ni importer `MatchingModule`/`ClaimsModule` directement (toujours
 * via le service public `RealtimeGateway`, cohérent avec ARCHITECTURE.md —
 * modules séparés par interfaces publiques). N'affecte pas le protocole
 * WebSocket existant (toujours émis à l'identique côté `server`).
 */
@Injectable()
@WebSocketGateway({ cors: { origin: process.env.CORS_ORIGIN ?? '*' }, namespace: '/realtime' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger('RealtimeGateway');
  private readonly internalEmitter = new EventEmitter();

  constructor(@Inject(AUTH_PROVIDER) private readonly authProvider: AuthProvider) {
    // Beaucoup d'abonnés internes possibles (Fraud, futurs modules) — évite
    // le warning MaxListenersExceeded par défaut (10) de Node.
    this.internalEmitter.setMaxListeners(50);
  }

  async handleConnection(client: Socket): Promise<void> {
    // ⚠️ Corrigé en revue Testeur, sprint 3 : un navigateur réel ne peut pas
    // poser d'en-tête personnalisé (`x-dev-user`) sur un handshake WebSocket
    // brut (contrairement à curl/Node, qui peuvent — repli conservé pour
    // ceux-ci). Le client Socket.IO transmet donc l'identité dev via
    // `auth` (`io(url, { auth: { devUser } })`), lu ici depuis
    // `handshake.auth` et injecté dans un en-tête synthétique pour
    // réutiliser `AuthProvider.resolve({ headers })` sans changer sa forme
    // (même interface que `KeycloakStrategy`).
    const auth = (client.handshake.auth ?? {}) as { devUser?: unknown; token?: string };
    const headers: Record<string, unknown> = { ...client.handshake.headers };
    if (auth.devUser !== undefined) {
      headers['x-dev-user'] = typeof auth.devUser === 'string' ? auth.devUser : JSON.stringify(auth.devUser);
    }
    if (auth.token) {
      headers['authorization'] = `Bearer ${auth.token}`;
    }
    const user = await this.authProvider.resolve({ headers });
    if (!user) {
      this.logger.warn(`Connexion WS refusée (non authentifiée): ${client.id}`);
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Authentification requise (en-tête x-dev-user).' });
      client.disconnect(true);
      return;
    }
    client.join('tenant:place');
    if (user.companyId) client.join(`tenant:${user.companyId}`);
    this.logger.log(`Client connecté: ${client.id} (${user.role}${user.companyId ? `, ${user.companyId}` : ''})`);
  }

  handleDisconnect(client: Socket): void {
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

@Module({ providers: [RealtimeGateway], exports: [RealtimeGateway] })
export class RealtimeModule {}
