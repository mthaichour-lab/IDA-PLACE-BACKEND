import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Socket } from 'net';

/**
 * SEC-29 — analyse antivirus BRANCHABLE des pièces avant mise à
 * disposition. Désactivée par défaut (`ANTIVIRUS_MODE` absent ou
 * `disabled`) : seul le contrôle de signature des octets s'applique alors.
 *
 * `ANTIVIRUS_MODE=clamd` active l'analyse par un démon ClamAV (protocole
 * `INSTREAM` sur TCP, sans dépendance) : `CLAMD_HOST` (défaut `localhost`),
 * `CLAMD_PORT` (défaut 3310), `CLAMD_TIMEOUT_MS` (défaut 15000). Fermé par
 * défaut : un démon injoignable ou une réponse illisible refuse le dépôt
 * (503), un fichier détecté est refusé (400 FICHIER_INFECTE).
 */
export const ANTIVIRUS_SCANNER = Symbol('ANTIVIRUS_SCANNER');

export interface AntivirusVerdict {
  clean: boolean;
  /** Nom de la signature détectée (ex. « Eicar-Test-Signature »). */
  signature?: string;
}

export interface AntivirusScanner {
  readonly mode: 'DISABLED' | 'CLAMD';
  scan(content: Buffer): Promise<AntivirusVerdict>;
}

export class DisabledAntivirusScanner implements AntivirusScanner {
  readonly mode = 'DISABLED' as const;

  async scan(): Promise<AntivirusVerdict> {
    return { clean: true };
  }
}

export interface ClamdOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

/** Client minimal clamd (`zINSTREAM`) : blocs `[longueur 32 bits][octets]`, bloc vide final, réponse `stream: OK` ou `stream: <signature> FOUND`. */
export class ClamdAntivirusScanner implements AntivirusScanner {
  readonly mode = 'CLAMD' as const;

  constructor(private readonly opts: ClamdOptions) {}

  scan(content: Buffer): Promise<AntivirusVerdict> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      const fail = (reason: string) => {
        socket.destroy();
        reject(new ServiceUnavailableException({ code: 'ANTIVIRUS_INDISPONIBLE', message: `Analyse antivirus impossible (${reason}) : dépôt refusé.` }));
      };
      socket.setTimeout(this.opts.timeoutMs, () => fail('délai dépassé'));
      socket.once('error', (err) => fail(err.message));
      socket.on('data', (d) => chunks.push(d));
      socket.once('end', () => {
        const reply = Buffer.concat(chunks).toString('utf-8').replace(/\0/g, '').trim();
        socket.destroy();
        if (/:\s*OK$/.test(reply)) return resolve({ clean: true });
        const found = /:\s*(.+)\s+FOUND$/.exec(reply);
        if (found) return resolve({ clean: false, signature: found[1] });
        fail(`réponse inattendue « ${reply.slice(0, 80)} »`);
      });
      socket.connect(this.opts.port, this.opts.host, () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < content.length; i += 64 * 1024) {
          const chunk = content.subarray(i, i + 64 * 1024);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(size);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }
}

@Injectable()
export class AntivirusFactory {
  private readonly logger = new Logger('Antivirus');

  create(env: Record<string, string | undefined> = process.env): AntivirusScanner {
    const mode = (env.ANTIVIRUS_MODE ?? 'disabled').toLowerCase();
    if (mode === 'clamd') {
      const port = Number(env.CLAMD_PORT ?? 3310);
      const timeoutMs = Number(env.CLAMD_TIMEOUT_MS ?? 15000);
      if (!Number.isInteger(port) || port <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('ANTIVIRUS_MODE=clamd : CLAMD_PORT/CLAMD_TIMEOUT_MS invalides.');
      }
      this.logger.log(`Analyse antivirus des pièces active (clamd ${env.CLAMD_HOST ?? 'localhost'}:${port}).`);
      return new ClamdAntivirusScanner({ host: env.CLAMD_HOST ?? 'localhost', port, timeoutMs });
    }
    if (mode !== 'disabled') throw new Error(`ANTIVIRUS_MODE inconnu : « ${mode} » (attendu : disabled | clamd).`);
    this.logger.warn('Analyse antivirus des pièces DÉSACTIVÉE (ANTIVIRUS_MODE=disabled) : seul le contrôle de signature des octets s’applique.');
    return new DisabledAntivirusScanner();
  }
}
