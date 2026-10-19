import { BadRequestException } from '@nestjs/common';

/**
 * SEC-29 — contrôle du CONTENU des pièces téléversées (implémentation
 * maison, sans dépendance) : le type réel est déduit de la signature des
 * octets, jamais du type MIME déclaré par le client ni de l'extension. Un
 * HTML, un exécutable ou le fichier de test EICAR renommés en `.pdf` sont
 * refusés.
 */

export const ALLOWED_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedDocumentType = (typeof ALLOWED_DOCUMENT_TYPES)[number];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Type réel d'après les premiers octets, ou `undefined` si ce n'est aucun des types autorisés. */
export function detectDocumentType(content: Buffer): AllowedDocumentType | undefined {
  if (content.length >= 5 && content.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg';
  if (content.length >= 8 && content.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (content.length >= 12 && content.subarray(0, 4).toString('latin1') === 'RIFF' && content.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

/**
 * Le type déclaré (multipart) doit être autorisé ET correspondre au type
 * réel. Renvoie le type réel, seul conservé en base et resservi au
 * téléchargement.
 */
export function assertDocumentContent(content: Buffer, declaredType: string): AllowedDocumentType {
  const actual = detectDocumentType(content);
  if (!actual) {
    throw new BadRequestException({ code: 'TYPE_NON_AUTORISE', message: 'Contenu refusé : seuls les PDF, JPEG, PNG et WEBP réels sont acceptés.' });
  }
  if (actual !== declaredType) {
    throw new BadRequestException({ code: 'TYPE_INCOHERENT', message: 'Le contenu du fichier ne correspond pas à son type déclaré.' });
  }
  return actual;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * SEC-10 — nom d'origine conservé en métadonnée seulement (jamais dans la
 * clé de stockage) : `..`, `/`, `\` et caractères de contrôle refusés ; le
 * reste est réduit à un jeu de caractères sûr pour l'en-tête
 * `Content-Disposition`.
 */
export function safeOriginalFilename(name: string | undefined): string {
  const raw = (name ?? '').trim();
  if (raw.includes('..') || raw.includes('/') || raw.includes('\\') || CONTROL_CHARS.test(raw)) {
    throw new BadRequestException({ code: 'NOM_FICHIER_INVALIDE', message: 'Nom de fichier invalide.' });
  }
  const safe = raw.replace(/[^A-Za-z0-9.\-_]/g, '_').slice(0, 200);
  return safe.length > 0 ? safe : 'fichier';
}
