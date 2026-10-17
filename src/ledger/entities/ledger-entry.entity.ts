import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

/**
 * LedgerEntry — écran 13 "Journal scellé", B.2/B.3. Chaînage d'empreintes
 * SHA-256 (`hash(n) = f(événement, hash(n-1))`) — voir `ledger.service.ts`.
 *
 * Append-only : `LedgerService` n'expose jamais de méthode `update`/
 * `delete` au niveau applicatif. `seq` (entier auto-incrémenté) fixe
 * l'ordre total strict de la chaîne — `id` (uuid) n'est qu'un identifiant
 * d'adressage externe, jamais utilisé pour l'ordre (deux entrées pourraient
 * en théorie partager le même timestamp `at`).
 *
 * TODO(backend-agent) : renforcer l'immuabilité au niveau base (REVOKE
 * UPDATE/DELETE sur `ledger_entry` pour le rôle applicatif) une fois les
 * rôles PostgreSQL de production définis — non fait ici car aucune instance
 * PostgreSQL n'est disponible dans cet environnement pour valider une telle
 * contrainte sans casser le rôle unique `ida_place` utilisé en dev.
 */
@Entity({ tableName: 'ledger_entry' })
export class LedgerEntry {
  @PrimaryKey({ type: 'integer', autoincrement: true })
  seq!: number;

  @Property({ type: 'uuid', unique: true })
  id: string = v4();

  @Property()
  type!: string;

  @Property()
  ref!: string;

  @Property()
  actor!: string;

  @Property({ type: 'text' })
  summary!: string;

  @Property()
  at: Date = new Date();

  @Property({ length: 64 })
  prevHash!: string;

  @Property({ length: 64 })
  hash!: string;
}
