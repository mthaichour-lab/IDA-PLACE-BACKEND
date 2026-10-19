import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server, ServerOptions } from 'socket.io';

/** Taille maximale d'un message Socket.IO entrant (le client n'émet rien, seul le handshake transporte le jeton). */
export const REALTIME_MAX_HTTP_BUFFER_SIZE = 100_000;

/**
 * SEC-07 (revue sécurité 2026-10-19) — adaptateur Socket.IO configuré au
 * démarrage (`configureApp`), APRÈS le chargement et la validation de la
 * configuration.
 *
 * AVANT : l'origine CORS du WebSocket était lue dans le décorateur
 * `@WebSocketGateway({ cors: { origin: process.env.CORS_ORIGIN ?? '*' } })`,
 * évalué au chargement du module, donc avant `ConfigModule` : en pratique
 * `'*'`. Le décorateur porte désormais une valeur fermée (`origin: false`) et
 * c'est cet adaptateur qui applique la liste explicite d'origines
 * (`CORS_ORIGIN`, jamais `*`, validée par `validateEnv`).
 */
export class RealtimeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly allowedOrigins: string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.allowedOrigins, credentials: true },
      maxHttpBufferSize: REALTIME_MAX_HTTP_BUFFER_SIZE,
    } as ServerOptions);
  }
}
