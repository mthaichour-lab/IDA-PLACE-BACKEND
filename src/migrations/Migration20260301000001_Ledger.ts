import { Migration } from '@mikro-orm/migrations';

/**
 * Migration — table `ledger_entry` (B.3, écran 13 : persistance du
 * chaînage SHA-256 de `LedgerModule`, déjà réel, auparavant en mémoire
 * uniquement). Extraite d'une migration bundlée plus large après
 * intégration du travail d'une session parallèle sur
 * `recours`/`settlement_monthly`/`compensation_quarter`/`commission_*`
 * (voir HANDOFF.md) — ces tables viennent de leur propre migration,
 * celle-ci ne couvre plus que `ledger_entry`.
 *
 * Écrite à la main (voir `Migration20260101000000_Initial.ts`) : aucune
 * instance PostgreSQL disponible dans cet environnement de développement.
 */
export class Migration20260301000001_Ledger extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "ledger_entry" (
        "seq" serial primary key,
        "id" uuid not null,
        "type" varchar(255) not null,
        "ref" varchar(255) not null,
        "actor" varchar(255) not null,
        "summary" text not null,
        "at" timestamptz not null default now(),
        "prev_hash" varchar(64) not null,
        "hash" varchar(64) not null
      );
      create unique index "ledger_entry_id_unique" on "ledger_entry" ("id");
    `);
    // TODO(backend-agent, voir ledger-entry.entity.ts) : REVOKE UPDATE/DELETE
    // sur "ledger_entry" pour le rôle applicatif une fois les rôles
    // PostgreSQL de production définis (append-only strict en base) — non
    // fait ici pour ne pas casser le rôle unique "ida_place" utilisé en dev.
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "ledger_entry";');
  }
}
