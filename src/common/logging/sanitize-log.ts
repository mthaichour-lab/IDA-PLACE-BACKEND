/**
 * SEC-45 — neutralisation des valeurs non fiables avant journalisation.
 *
 * Un en-tête (`x-dev-user`), un `kid` de JWT ou un message d'erreur peuvent
 * contenir des retours à la ligne ou des séquences d'échappement terminal :
 * journalisés tels quels, ils permettent de fabriquer de fausses lignes de
 * journal (brouillage de l'audit). Chaque caractère de contrôle (C0, DEL, C1,
 * séparateurs de ligne Unicode) est remplacé par sa forme échappée visible
 * (`\n`, `\u001b`...) et la valeur est tronquée : une valeur journalisée
 * produit toujours UNE seule ligne, de longueur bornée.
 */
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

const NAMED_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

export const DEFAULT_LOG_VALUE_MAX_LENGTH = 200;

export function sanitizeForLog(value: unknown, maxLength = DEFAULT_LOG_VALUE_MAX_LENGTH): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (value instanceof Error) {
    text = value.message;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const truncated = text.length > maxLength ? `${text.slice(0, maxLength)}…[tronqué ${text.length - maxLength} car.]` : text;
  return truncated.replace(
    CONTROL_CHARS,
    (c) => NAMED_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
