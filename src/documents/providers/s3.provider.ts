import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { attachmentDisposition, DocumentStorageConfig, resolveDocumentStorageConfig } from '../storage-config';
import { DownloadUrlOptions, StorageProvider, StoredDocument } from './storage-provider.interface';

/**
 * S3StorageProvider — intégration MinIO/S3 réelle (B.10), obligatoire en
 * production (SEC-11, voir `storage-config.ts`).
 *
 * Instancié TOUJOURS aux côtés de `LocalFsStorageProvider` (même principe
 * que `KeycloakStrategy`/`DevAuthProvider`) : le client S3 n'est construit,
 * et la configuration vérifiée, QUE si `S3_ENABLED=true`. Compatible MinIO
 * (`forcePathStyle: true`, endpoint personnalisé).
 *
 *  - `put()` : dépôt avec chiffrement côté serveur demandé à S3
 *    (`ServerSideEncryption`, SSE-S3 ou SSE-KMS selon `S3_SSE`), type réel
 *    vérifié et `Content-Disposition: attachment` enregistrés sur l'objet.
 *    Le bucket doit rester privé (configuration infra).
 *  - `presignedDownloadUrl()` : URL GET pré-signée à durée courte (~15 min,
 *    B.10) qui impose `Content-Disposition: attachment` et le type réel à la
 *    réponse (un PDF piégé n'est jamais rendu en ligne par le navigateur).
 *    `X-Content-Type-Options: nosniff` n'est pas paramétrable par une URL
 *    pré-signée : il est ajouté par `GET /documents/:id/download` (API) et
 *    doit l'être par le reverse proxy devant MinIO.
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  readonly mode = 'S3' as const;
  private readonly logger = new Logger('S3StorageProvider');
  private readonly client?: S3Client;
  private readonly bucket?: string;
  private readonly config: DocumentStorageConfig;

  constructor() {
    // Vérifie aussi la règle de production (S3 obligatoire) : jamais de succès simulé.
    this.config = resolveDocumentStorageConfig();
    if (this.config.useS3) {
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
      this.logger.log(`S3StorageProvider actif (endpoint=${process.env.S3_ENDPOINT}, bucket=${this.bucket}, SSE=${this.config.sse ?? 'aucun'}).`);
    }
  }

  private requireClient(): { client: S3Client; bucket: string } {
    if (!this.client || !this.bucket) {
      throw new Error('S3StorageProvider non actif (S3_ENABLED=false) — configurer S3_ENABLED=true pour l’intégration MinIO/S3 réelle.');
    }
    return { client: this.client, bucket: this.bucket };
  }

  /** Paramètres de chiffrement côté serveur de `PutObject` (exportés pour test). */
  sseParams(): { ServerSideEncryption?: 'AES256' | 'aws:kms'; SSEKMSKeyId?: string } {
    if (!this.config.sse) return {};
    return { ServerSideEncryption: this.config.sse, ...(this.config.sseKmsKeyId ? { SSEKMSKeyId: this.config.sseKmsKeyId } : {}) };
  }

  async put(key: string, content: Buffer, contentType: string): Promise<StoredDocument> {
    const { client, bucket } = this.requireClient();
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: content, ContentType: contentType, ContentDisposition: 'attachment', ...this.sseParams() }),
    );
    this.logger.log(`Document stocké sur S3/MinIO : ${bucket}/${key}`);
    return { key, sizeBytes: content.length, contentType };
  }

  async get(key: string): Promise<Buffer> {
    const { client, bucket } = this.requireClient();
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await (res.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
  }

  /** URL pré-signée GET, durée courte par défaut (~15 min, B.10), en pièce jointe et type imposé. */
  async presignedDownloadUrl(key: string, opts: DownloadUrlOptions): Promise<string> {
    const { client, bucket } = this.requireClient();
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: attachmentDisposition(opts.filename),
      ResponseContentType: opts.contentType,
    });
    return getSignedUrl(client, command, { expiresIn: opts.ttlSeconds ?? 900 });
  }
}
