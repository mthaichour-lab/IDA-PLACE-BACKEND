import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AUTH_PROVIDER, AuthProvider } from '../common/interfaces/authenticated-user.interface';

export type RealtimeEvent = 'claim.ingested' | 'match.updated' | 'recours.timer' | 'metering.tick' | 'ledger.appended';

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
 */
@Injectable()
@WebSocketGateway({ cors: { origin: process.env.CORS_ORIGIN ?? '*' }, namespace: '/realtime' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger('RealtimeGateway');

  constructor(@Inject(AUTH_PROVIDER) private readonly authProvider: AuthProvider) {}

  async handleConnection(client: Socket): Promise<void> {
    const user = await this.authProvider.resolve({ headers: client.handshake.headers as Record<string, unknown> });
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

  emitEvent(event: RealtimeEvent, payload: unknown, room = 'tenant:place'): void {
    this.server?.to(room).emit(event, payload);
  }
}

@Module({ providers: [RealtimeGateway], exports: [RealtimeGateway] })
export class RealtimeModule {}
