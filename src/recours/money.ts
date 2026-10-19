/**
 * SEC-06 / SEC-34 — montants en dinars avec deux décimales au plus.
 *
 * Les colonnes sont en `numeric(18,2)` (lues en `number` par
 * `DecimalType('number')`), mais toute ARITHMÉTIQUE (sommes, netting,
 * compensation) se fait en centimes entiers : un `number` JavaScript
 * représente exactement tout entier jusqu'à 2^53, donc les sommes de
 * centimes sont exactes et la somme des positions multilatérales vaut
 * exactement 0. La conversion n'a lieu qu'aux bornes (`toCents` en entrée,
 * `fromCents` en sortie).
 */

/** Plafond technique absolu d'un montant (10 milliards DA) : bien en deçà de `numeric(18,2)` et de 2^53 centimes. */
export const MAX_TECHNICAL_AMOUNT_DA = 10_000_000_000;

export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new RangeError(`Montant non fini : ${amount}`);
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Montant hors bornes : ${amount}`);
  return cents;
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** Somme exacte de montants à deux décimales. */
export function sumAmounts(amounts: number[]): number {
  return fromCents(amounts.reduce((acc, a) => acc + toCents(a), 0));
}

/** Vrai si `amount` est fini, strictement positif, a au plus deux décimales et respecte le plafond technique. */
export function isValidMoney(amount: unknown): amount is number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > MAX_TECHNICAL_AMOUNT_DA) return false;
  return Math.abs(Math.round(amount * 100) - amount * 100) < 1e-6;
}
