import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { StorageProvider, StoredDocument } from './storage-provider.interface';

const REQUIRED_ENV = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const;

/**
 * S3StorageProvider — intégration MinIO/S3 réelle (B.10).
 *
 * Activée par `S3_ENABLED=true` (voir documents.module.ts, qui instancie
 * TOUJOURS cette classe aux côtés de `LocalFsStorageProvider` — même
 * principe que `KeycloakStrategy`/`DevAuthProvider` : le constructeur ne
 * doit jamais planter l'application en mode dégradé, donc le client S3
 * n'est construit, et la configuration vérifiée, QUE si `S3_ENABLED=true`).
 * Compatible MinIO (`forcePathStyle: true`, endpoint personnalisé).
 *
 *  - `put()` : upload objet (nommage déjà géré en amont par
 *    `DocumentsService.upload` — `{tenant}/{timestamp}-{filename}`, voir
 *    documents.module.ts). Chiffrement au repos (SSE côté bucket MinIO/S3 —
 *    à configurer sur le bucket lui-même, pas dans ce provider) — TODO
 *    infra, hors périmètre du code applicatif.
 *  - `getPresignedUrl()` : URL pré-signée GET, durée courte (~15 min par
 *    défaut, B.10 — ne jamais l'allonger sans revoir B.10).
 *
 * TODO sprint suivant : orchestrer l'envoi à Paperless (OCR/indexation)
 * après upload S3 (voir `documents.service.ts`), traçabilité de
 * consultation (RG-09), filigrane dynamique (fait côté front).
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  readonly mode = 'S3' as const;
  private readonly logger = new Logger('S3StorageProvider');
  private readonly client?: S3Client;
  private readonly bucket?: string;

  constructor() {
    if (process.env.S3_ENABLED === 'true') {
      this.assertConfigured();
      this.bucket = process.env.S3_BUCKET;
      this.client = new S3Client({
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION ?? 'us-east-1',
        forcePathStyle: true, // requis pour MinIO (adressage par chemin, pas par sous-domaine de bucket).
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY as string,
          secretAccessKey: process.env.S3_SECRET_KEY as string,
        },
      });
      this.logger.log(`S3StorageProvider actif (endpoint=${process.env.S3_ENDPOINT}, bucket=${this.bucket}).`);
    }
  }

  /**
   * Vérifie la configuration minimale requise quand `S3_ENABLED=true` — même
   * principe zero-trust que `KeycloakStrategy.assertConfigured()` : jamais
   * de succès simulé si la configuration est incomplète.
   */
  private assertConfigured(): void {
    const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`S3StorageProvider: S3_ENABLED=true mais configuration manquante (${missing.join(', ')}).`);
    }
  }

  private requireClient(): { client: S3Client; bucket: string } {
    if (!this.client || !this.bucket) {
      throw new Error('S3StorageProvider non actif (S3_ENABLED=false) — configurer S3_ENABLED=true pour l’intégration MinIO/S3 réelle.');
    }
    return { client: this.client, bucket: this.bucket };
  }

  async put(key: string, content: Buffer, contentType: string): Promise<StoredDocument> {
    const { client, bucket } = this.requireClient();
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content, ContentType: contentType }));
    this.logger.log(`Document stocké sur S3/MinIO : ${bucket}/${key}`);
    return { key, sizeBytes: content.length, contentType };
  }

  /** URL pré-signée GET, durée courte par défaut (~15 min, B.10). */
  async getPresignedUrl(key: string, ttlSeconds = 900): Promise<string> {
    const { client, bucket } = this.requireClient();
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(client, command, { expiresIn: ttlSeconds });
  }
}
