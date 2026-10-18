import { createHmac } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve, sep } from 'path';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { logDegraded } from '../../common/interfaces/degraded-mode';
import { StorageProvider, StoredDocument } from './storage-provider.interface';

/**
 * Repli dev EXPLICITE de DocumentsModule quand MinIO/S3 est injoignable
 * (`S3_ENABLED=false`). Écrit sur disque local (chiffrement réel non
 * implémenté ici — TODO backend-agent) et simule une URL pré-signée à
 * durée courte via un jeton HMAC vérifiable, au lieu d'une vraie signature
 * S3. Ne JAMAIS utiliser en production (voir README "Mode dégradé").
 */
@Injectable()
export class LocalFsStorageProvider implements StorageProvider {
  readonly mode = 'LOCAL_FS_DEGRADED' as const;
  private readonly logger = new Logger('LocalFsStorageProvider');
  private readonly baseDir = process.env.LOCAL_STORAGE_DIR ?? './.data/documents';
  private readonly secret = process.env.DEV_JWT_SECRET ?? 'dev-local-only-secret-change-me';

  constructor() {
    logDegraded('DocumentsModule', 'S3_ENABLED=false — stockage sur disque local non chiffré, usage dev uniquement.');
  }

  async put(key: string, content: Buffer, contentType: string): Promise<StoredDocument> {
    const base = resolve(this.baseDir);
    const path = resolve(base, key);
    // Revue sécurité 2026-10-18 : défense en profondeur — `join()` seul ne
    // clampe PAS au répertoire de base (il normalise juste les `..`), donc
    // une `key` contenant assez de `../` peut sortir de `baseDir`. L'appelant
    // (`DocumentsService.upload`) assainit déjà `file.originalname`, mais ce
    // contrôle protège tout futur appelant qui oublierait de le faire.
    if (path !== base && !path.startsWith(base + sep)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Clé de document invalide.' });
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    this.logger.log(`Document stocké (mode dégradé) : ${path}`);
    return { key, sizeBytes: content.length, contentType };
  }

  async getPresignedUrl(key: string, ttlSeconds = 900): Promise<string> {
    const expires = Date.now() + ttlSeconds * 1000;
    const sig = createHmac('sha256', this.secret).update(`${key}|${expires}`).digest('hex').slice(0, 24);
    return `/api/v1/documents/local/${encodeURIComponent(key)}?expires=${expires}&sig=${sig}`;
  }
}
