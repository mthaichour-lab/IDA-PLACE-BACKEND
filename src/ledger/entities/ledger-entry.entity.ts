import { Entity, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

/**
 * LedgerEntry — écran 13 "Journal scellé", B.2/B.3. Chaînage d'empreintes
 * (`hash(n) = f(événement, hash(n-1))`) — voir `ledger.service.ts`.
 *
 * Append-only, garanti en base depuis SEC-15 (migration
 * `Migration20261020000100_LedgerIntegrity`) : trigger refusant `UPDATE`,
 * `DELETE` et `TRUNCATE`, `UNIQUE(prev_hash)` (aucune fourche possible),
 * `REVOKE` documenté pour le rôle applicatif. `seq` (entier auto-incrémenté)
 * fixe l'ordre total strict de la chaîne.
 *
 * `hashVersion` (SEC-15) : 1 = ancienne empreinte SHA-256 sans secret sur une
 * concaténation `|` (entrées antérieures à la migration, vérifiées telles
 * quelles et signalées comme « héritées ») ; 2 = HMAC-SHA256 (clé
 * `LEDGER_HMAC_KEY`, hors base) sur un encodage canonique JSON.
 */
@Entity({ tableName: 'ledger_entry' })
export class LedgerEntry {
  [OptionalProps]?: 'seq' | 'id' | 'at' | 'hashVersion';

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

  @Property({ length: 64, unique: true })
  prevHash!: string;

  @Property({ length: 64 })
  hash!: string;

  @Property({ type: 'smallint' })
  hashVersion: number = 2;
}
