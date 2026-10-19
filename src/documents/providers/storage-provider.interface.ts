/**
 * Contrat de stockage documentaire — B.10. Implémenté soit par
 * `S3StorageProvider` (MinIO/S3, production — obligatoire, SEC-11), soit
 * par `LocalFsStorageProvider` (repli de développement, refusé en
 * production). Le reste de l'application ne dépend que de cette interface.
 *
 * SEC-10 : aucune méthode ne reçoit une clé fournie par le client — les clés
 * sont générées (aléatoires) et lues en base par `DocumentsService`, après
 * contrôle d'accès sur l'identifiant du document.
 */
export interface StoredDocument {
  key: string;
  sizeBytes: number;
  contentType: string;
}

export interface DownloadUrlOptions {
  /** Nom proposé au téléchargement (`Content-Disposition: attachment`). */
  filename: string;
  /** Type de contenu imposé à la réponse (le type réel vérifié au dépôt). */
  contentType: string;
  ttlSeconds?: number;
}

export interface StorageProvider {
  readonly mode: 'S3' | 'LOCAL_FS_DEGRADED';
  put(key: string, content: Buffer, contentType: string): Promise<StoredDocument>;
  /** Octets d'un document (téléchargement servi par l'API, après contrôle d'accès). */
  get(key: string): Promise<Buffer>;
  /**
   * URL directe à durée courte (≈15 min, B.10), en pièce jointe et type
   * imposé — seulement pour un stockage capable de signer lui-même (S3).
   * Absente en mode local : le téléchargement passe par l'API.
   */
  presignedDownloadUrl?(key: string, opts: DownloadUrlOptions): Promise<string>;
}
