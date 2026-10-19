import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/**
 * LedgerHead — ancre de tête du journal scellé (SEC-15) : nombre d'entrées
 * et empreinte de la dernière entrée, scellés par un HMAC (`mac`, clé
 * `LEDGER_HMAC_KEY` hors base). Mise à jour dans la MÊME transaction que
 * chaque ajout (sous verrou consultatif). `verifyChain` compare la chaîne
 * réelle à cette ancre : une table vidée ou tronquée (suppression des
 * dernières entrées) est détectée.
 *
 * Limite assumée : un administrateur de base qui aurait conservé une ancienne
 * paire (chaîne, ancre) pourrait la rejouer ; l'ancrage EXTERNE périodique
 * de `headHash`/`entries` (renvoyés par `GET /ledger/verify`) dans un système
 * hors base est à mettre en place côté exploitation.
 */
@Entity({ tableName: 'ledger_head' })
export class LedgerHead {
  @PrimaryKey({ type: 'smallint', autoincrement: false })
  id: number = 1;

  @Property({ type: 'integer' })
  entryCount!: number;

  @Property({ type: 'integer' })
  headSeq!: number;

  @Property({ length: 64 })
  headHash!: string;

  @Property({ length: 64 })
  mac!: string;

  @Property()
  updatedAt: Date = new Date();
}
