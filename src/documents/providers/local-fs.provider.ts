import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve, sep } from 'path';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { logDegraded } from '../../common/interfaces/degraded-mode';
import { StorageProvider, StoredDocument } from './storage-provider.interface';

/**
 * Repli de DÉVELOPPEMENT de DocumentsModule (`S3_ENABLED` différent de
 * `true`). Écrit sur disque local non chiffré : refusé au démarrage en
 * production (SEC-11, voir `storage-config.ts`).
 *
 * SEC-11 : plus d'URL « pré-signée » maison — l'ancien jeton HMAC était
 * signé avec DEV_JWT_SECRET, dont la valeur de repli est publique
 * (`.env.example`). Les pièces locales sont servies par
 * `GET /documents/:id/download`, authentifiée et contrôlée à chaque appel.
 */
@Injectable()
export class LocalFsStorageProvider implements StorageProvider {
  readonly mode = 'LOCAL_FS_DEGRADED' as const;
  private readonly logger = new Logger('LocalFsStorageProvider');
  private readonly baseDir = process.env.LOCAL_STORAGE_DIR ?? './.data/documents';

  constructor() {
    logDegraded('DocumentsModule', 'S3_ENABLED=false — stockage sur disque local non chiffré, usage dev uniquement (refusé en production).');
  }

  /**
   * Revue sécurité 2026-10-18 : défense en profondeur — `resolve()` seul ne
   * clampe PAS au répertoire de base, d'où le contrôle de confinement (les
   * clés sont désormais générées par `DocumentsService`, jamais issues du
   * client, mais ce contrôle protège tout futur appelant).
   */
  private pathFor(key: string): string {
    const base = resolve(this.baseDir);
    const path = resolve(base, key);
    if (path === base || !path.startsWith(base + sep)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Clé de document invalide.' });
    }
    return path;
  }

  async put(key: string, content: Buffer, contentType: string): Promise<StoredDocument> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    this.logger.log(`Document stocké (mode dégradé) : ${key}`);
    return { key, sizeBytes: content.length, contentType };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Document introuvable.' });
      throw err;
    }
  }
}
