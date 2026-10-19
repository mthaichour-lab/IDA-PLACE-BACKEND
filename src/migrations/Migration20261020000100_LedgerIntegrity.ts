import { Migration } from '@mikro-orm/migrations';

/**
 * SEC-15 (revue sécurité 2026-10-19) — intégrité du journal scellé en base.
 *
 * 1. `hash_version` : les entrées existantes sont marquées version 1
 *    (empreinte SHA-256 historique, sans secret) et restent vérifiées telles
 *    quelles ; toute nouvelle entrée est en version 2 (HMAC-SHA256, clé
 *    `LEDGER_HMAC_KEY` hors base). La première entrée v2 chaîne sur la
 *    dernière entrée v1 : son `prev_hash` est couvert par le HMAC, ce qui
 *    protège rétroactivement tout le préfixe historique. Pas de nouvelle
 *    genèse : la chaîne reste unique et continue.
 * 2. `UNIQUE(prev_hash)` : deux entrées ne peuvent plus chaîner sur la même
 *    entrée (aucune fourche). La migration échoue explicitement si une
 *    fourche existe déjà (à investiguer avant de migrer).
 * 3. Trigger refusant `UPDATE`, `DELETE` et `TRUNCATE` sur `ledger_entry`
 *    (y compris pour le propriétaire de la table), et `DELETE`/`TRUNCATE`
 *    sur `ledger_head`.
 * 4. Table `ledger_head` : ancre de tête (nombre d'entrées, dernière
 *    empreinte, HMAC) mise à jour dans la transaction de chaque ajout.
 * 5. Rôles SQL (à appliquer par l'exploitation, la migration le fait si le
 *    rôle conventionnel `ida_place_app` existe) : le rôle APPLICATIF n'a que
 *    `SELECT, INSERT` sur `ledger_entry` et `SELECT, INSERT, UPDATE` sur
 *    `ledger_head` ; les migrations s'exécutent avec un rôle distinct,
 *    propriétaire du schéma :
 *
 *      REVOKE ALL ON ledger_entry, ledger_head FROM ida_place_app;
 *      GRANT SELECT, INSERT ON ledger_entry TO ida_place_app;
 *      GRANT USAGE ON SEQUENCE ledger_entry_seq_seq TO ida_place_app;
 *      GRANT SELECT, INSERT, UPDATE ON ledger_head TO ida_place_app;
 *
 *    Le trigger reste la protection minimale si un seul rôle est utilisé.
 */
export class Migration20261020000100_LedgerIntegrity extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      do $$
      begin
        if exists (select prev_hash from "ledger_entry" group by prev_hash having count(*) > 1) then
          raise exception 'ledger_entry contient une fourche (prev_hash dupliqué) : investiguer avant d''appliquer SEC-15';
        end if;
      end $$;
    `);
    this.addSql('alter table "ledger_entry" add column "hash_version" smallint not null default 1;');
    this.addSql('alter table "ledger_entry" alter column "hash_version" drop default;');
    this.addSql('alter table "ledger_entry" add constraint "ledger_entry_hash_version_check" check ("hash_version" in (1, 2));');
    this.addSql('create unique index "ledger_entry_prev_hash_unique" on "ledger_entry" ("prev_hash");');

    this.addSql(`
      create table "ledger_head" (
        "id" smallint not null primary key check ("id" = 1),
        "entry_count" integer not null check ("entry_count" >= 0),
        "head_seq" integer not null,
        "head_hash" varchar(64) not null,
        "mac" varchar(64) not null,
        "updated_at" timestamptz not null default now()
      );
    `);

    this.addSql(`
      create or replace function "ledger_forbid_mutation"() returns trigger language plpgsql as $$
      begin
        raise exception 'journal scellé : % interdit sur %', tg_op, tg_table_name using errcode = '42501';
      end $$;
    `);
    this.addSql(`
      create trigger "ledger_entry_append_only"
        before update or delete on "ledger_entry"
        for each row execute function "ledger_forbid_mutation"();
    `);
    this.addSql(`
      create trigger "ledger_entry_no_truncate"
        before truncate on "ledger_entry"
        for each statement execute function "ledger_forbid_mutation"();
    `);
    this.addSql(`
      create trigger "ledger_head_no_delete"
        before delete on "ledger_head"
        for each row execute function "ledger_forbid_mutation"();
    `);
    this.addSql(`
      create trigger "ledger_head_no_truncate"
        before truncate on "ledger_head"
        for each statement execute function "ledger_forbid_mutation"();
    `);

    this.addSql(`
      do $$
      begin
        if exists (select 1 from pg_roles where rolname = 'ida_place_app') then
          execute 'revoke all on "ledger_entry", "ledger_head" from ida_place_app';
          execute 'grant select, insert on "ledger_entry" to ida_place_app';
          execute 'grant usage on sequence "ledger_entry_seq_seq" to ida_place_app';
          execute 'grant select, insert, update on "ledger_head" to ida_place_app';
        end if;
      end $$;
    `);
  }

  /**
   * Protégé par `npm run migration:down` (refusé en production sans
   * `ALLOW_PRODUCTION_DESTRUCTIVE=true`, SEC-51). Ne supprime AUCUNE entrée :
   * retire seulement les protections ajoutées par `up()`.
   */
  override async down(): Promise<void> {
    this.addSql('drop trigger if exists "ledger_head_no_truncate" on "ledger_head";');
    this.addSql('drop trigger if exists "ledger_head_no_delete" on "ledger_head";');
    this.addSql('drop trigger if exists "ledger_entry_no_truncate" on "ledger_entry";');
    this.addSql('drop trigger if exists "ledger_entry_append_only" on "ledger_entry";');
    this.addSql('drop function if exists "ledger_forbid_mutation"();');
    this.addSql('drop table if exists "ledger_head";');
    this.addSql('drop index if exists "ledger_entry_prev_hash_unique";');
    this.addSql('alter table "ledger_entry" drop constraint if exists "ledger_entry_hash_version_check";');
    this.addSql('alter table "ledger_entry" drop column if exists "hash_version";');
  }
}
