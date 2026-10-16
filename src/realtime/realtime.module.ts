import { Injectable, Logger, Module } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

export type RealtimeEvent = 'claim.ingested' | 'match.updated' | 'recours.timer' | 'metering.tick' | 'ledger.appended';

/**
 * RealtimeModule — B.2/B.12 : passerelle WebSocket pour les dashboards
 * temps réel (écrans 1, 2, 10). Abonnement par salon tenant
 * (`join-tenant` → room `tenant:<companyId|place>`).
 *
 * TODO(backend-agent): voir §B.12 :
 *  - authentifier la connexion WS (token Keycloak / dev) avant de joindre
 *    un salon — actuellement aucune vérification (socket ouvert) ;
 *  - appeler `RealtimeGateway.emitEvent(...)` depuis ClaimsModule (import),
 *    MatchingModule (decide), RecoursModule (timers), MeteringModule
 *    (tick périodique) et LedgerModule (append) au lieu du seul exemple
 *    périodique ci-dessous ;
 *  - remplacer l'intervalle de démonstration par une file d'événements
 *    Redis (pub/sub) pour supporter plusieurs instances du back-end.
 */
@Injectable()
@WebSocketGateway({ cors: { origin: process.env.CORS_ORIGIN ?? '*' }, namespace: '/realtime' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger('RealtimeGateway');
  private demoInterval?: NodeJS.Timeout;

  handleConnection(client: Socket): void {
    this.logger.log(`Client connecté: ${client.id}`);
    client.join('tenant:place');
    if (!this.demoInterval) {
      // Démonstration : un tick périodique tant qu'aucun module métier
      // n'émet encore de vrais événements (voir TODO ci-dessus).
      this.demoInterval = setInterval(() => this.emitEvent('metering.tick', { at: new Date().toISOString() }), 15000);
    }
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
