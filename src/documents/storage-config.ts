/**
 * SEC-11 — configuration du stockage des pièces (constats, pièces
 * d'assurés : données personnelles).
 *
 *  - Production (`NODE_ENV=production`) : stockage objet S3/MinIO
 *    OBLIGATOIRE (`S3_ENABLED=true` et configuration complète), sinon le
 *    démarrage est refusé — plus de repli sur disque local non chiffré.
 *  - Chiffrement côté serveur demandé à S3 à chaque dépôt : `S3_SSE`
 *    = `AES256` (SSE-S3, défaut) ou `aws:kms` (SSE-KMS, clé optionnelle
 *    `S3_SSE_KMS_KEY_ID`). `none` n'est accepté qu'hors production (MinIO de
 *    développement sans KMS).
 *  - Aucune signature applicative : S3 signe ses URL avec ses propres
 *    identifiants ; en mode local (développement), les pièces sont servies
 *    par une route authentifiée qui contrôle l'accès à chaque requête —
 *    l'ancien HMAC « maison » signé avec DEV_JWT_SECRET (valeur publique de
 *    repli) est supprimé.
 */
export type S3ServerSideEncryption = 'AES256' | 'aws:kms';

export interface DocumentStorageConfig {
  useS3: boolean;
  sse?: S3ServerSideEncryption;
  sseKmsKeyId?: string;
}

const S3_REQUIRED_ENV = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const;

export function resolveDocumentStorageConfig(env: Record<string, string | undefined> = process.env): DocumentStorageConfig {
  const production = env.NODE_ENV === 'production';
  const useS3 = env.S3_ENABLED === 'true';
  if (production && !useS3) {
    throw new Error('SEC-11 : stockage objet obligatoire en production (S3_ENABLED=true et configuration S3/MinIO complète) — démarrage refusé.');
  }
  if (!useS3) return { useS3: false };

  const missing = S3_REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`S3_ENABLED=true mais configuration manquante (${missing.join(', ')}).`);

  const sse = (env.S3_SSE ?? 'AES256').trim();
  if (sse === 'none') {
    if (production) throw new Error('SEC-11 : S3_SSE=none refusé en production (chiffrement côté serveur obligatoire).');
    return { useS3: true };
  }
  if (sse !== 'AES256' && sse !== 'aws:kms') throw new Error(`S3_SSE inconnu : « ${sse} » (attendu : AES256 | aws:kms | none hors production).`);
  return { useS3: true, sse, sseKmsKeyId: sse === 'aws:kms' ? env.S3_SSE_KMS_KEY_ID || undefined : undefined };
}

/** Valeur d'en-tête `Content-Disposition: attachment` sûre (nom déjà assaini, RFC 6266 + RFC 5987). */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^A-Za-z0-9.\-_]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
