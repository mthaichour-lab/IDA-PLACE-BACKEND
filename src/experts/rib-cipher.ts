import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * SEC-49 — chiffrement du RIB des experts (AES-256-GCM, clé hors base :
 * variable `EXPERT_RIB_KEY`, 32 octets en base64 ou 64 caractères hexadécimaux).
 * Format stocké : `v1:<iv>:<tag>:<chiffré>` (base64). Aucune clé par défaut :
 * sans clé, un RIB est refusé plutôt que stocké en clair.
 */
export const RIB_ENVELOPE_PREFIX = 'v1:';

export function parseRibKey(raw: string | undefined): Buffer | undefined {
  if (!raw || !raw.trim()) return undefined;
  const text = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error('Configuration invalide : EXPERT_RIB_KEY doit faire 32 octets (base64 ou 64 caractères hexadécimaux).');
  return key;
}

export function encryptRib(rib: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(rib, 'utf8'), cipher.final()]);
  return `${RIB_ENVELOPE_PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptRib(envelope: string, key: Buffer): string {
  if (!envelope.startsWith(RIB_ENVELOPE_PREFIX)) throw new Error('RIB non chiffré (format hérité)');
  const [iv, tag, data] = envelope.slice(RIB_ENVELOPE_PREFIX.length).split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** Quatre derniers caractères significatifs, pour l'affichage masqué. */
export function ribLast4(rib: string): string {
  return rib.replace(/\s/g, '').slice(-4);
}
