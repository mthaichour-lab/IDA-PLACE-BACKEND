/**
 * Contrat de stockage documentaire — B.10. Implémenté soit par
 * `S3StorageProvider` (MinIO/S3, production), soit par
 * `LocalFsStorageProvider` (repli dev explicite, voir README "Mode
 * dégradé"). Le reste de l'application ne dépend que de cette interface.
 */
export interface StoredDocument {
  key: string;
  sizeBytes: number;
  contentType: string;
}

export interface StorageProvider {
  readonly mode: 'S3' | 'LOCAL_FS_DEGRADED';
  put(key: string, content: Buffer, contentType: string): Promise<StoredDocument>;
  /** URL pré-signée à durée courte (≈15 min, B.10). */
  getPresignedUrl(key: string, ttlSeconds?: number): Promise<string>;
}
