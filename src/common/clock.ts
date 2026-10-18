/**
 * Horloge injectable : les règles pures reçoivent toujours `now` en
 * paramètre (comme `recours.rules.ts`), et les services qui en ont besoin
 * l'obtiennent via ce jeton pour que les tests puissent figer « aujourd'hui ».
 */
export const CLOCK = Symbol('CLOCK');

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
