import { Injectable, Logger } from '@nestjs/common';
import { StorageProvider, StoredDocument } from './storage-provider.interface';

/**
 * TODO(backend-agent) — intégration S3/MinIO réelle (B.10).
 *
 * Non implémentée dans cet environnement (pas de MinIO disponible). À
 * faire pour la production :
 *   1. Ajouter un client S3 (ex: `@aws-sdk/client-s3` + `@aws-sdk/
 *      s3-request-presigner`, compatible MinIO via `S3_ENDPOINT`).
 *   2. `put()` : upload objet, nommage par tenant (`{companyId}/{docId}`),
 *      chiffrement au repos (SSE-S3 ou SSE-KMS selon l'infra).
 *   3. `getPresignedUrl()` : URL pré-signée GET, durée courte (≈15 min —
 *      respecter B.10, ne pas l'allonger).
 *   4. Orchestrer l'envoi à Paperless (OCR/indexation) après upload S3
 *      (voir `documents.service.ts`), avec traçabilité de consultation
 *      (RG-09) et filigrane dynamique à l'affichage (fait côté front).
 * Activé via `S3_ENABLED=true` (voir documents.module.ts) ; tant que non
 * implémenté, lève une erreur explicite plutôt qu'un faux succès.
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  readonly mode = 'S3' as const;
  private readonly logger = new Logger('S3StorageProvider');

  async put(): Promise<StoredDocument> {
    this.logger.error('S3StorageProvider non implémenté. Configurer S3_ENABLED=false pour le mode dégradé dev.');
    throw new Error('S3StorageProvider: intégration MinIO/S3 non implémentée (voir TODO dans le fichier).');
  }

  async getPresignedUrl(): Promise<string> {
    throw new Error('S3StorageProvider: intégration MinIO/S3 non implémentée (voir TODO dans le fichier).');
  }
}
