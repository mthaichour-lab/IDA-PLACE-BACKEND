import { Migration } from '@mikro-orm/migrations';

/**
 * Barème Art. 14 et catégorie de véhicule — décision PO §5. Aucune donnée
 * insérée (origine (c)) et aucune reprise des dossiers existants : les
 * nouvelles colonnes de `claim` et `match_queue_item` restent nulles.
 *
 * Écrite à la main (aucune instance PostgreSQL pour introspecter le schéma,
 * voir Migration20261018030000_ReferentielPlace.ts).
 */
export class Migration20261019010000_BaremeArt14 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "bareme_version" (
        "id" uuid not null primary key,
        "label" varchar(128) not null,
        "status" varchar(255) not null default 'BROUILLON',
        "source_ref" varchar(255) null,
        "created_by" varchar(255) not null,
        "created_at" timestamptz not null default now(),
        "updated_by" varchar(255) null,
        "validated_by" varchar(255) null,
        "validated_at" timestamptz null,
        constraint "bareme_version_label_unique" unique ("label")
      );
    `);

    this.addSql(`
      create table "bareme_case" (
        "id" uuid not null primary key,
        "version_id" uuid not null,
        "code" varchar(32) not null,
        "label" varchar(255) not null,
        "part_a" smallint not null,
        "part_b" smallint not null,
        "created_by" varchar(255) not null,
        "created_at" timestamptz not null default now(),
        "updated_by" varchar(255) null,
        constraint "bareme_case_version_id_code_unique" unique ("version_id", "code"),
        constraint "bareme_case_parts_check" check ("part_a" >= 0 and "part_b" >= 0 and "part_a" + "part_b" = 100)
      );
    `);

    this.addSql(`
      create table "vehicle_category" (
        "code" varchar(32) not null primary key,
        "label" varchar(255) not null,
        "status" varchar(255) not null default 'SAISI',
        "created_by" varchar(255) not null,
        "created_at" timestamptz not null default now(),
        "updated_by" varchar(255) null,
        "validated_by" varchar(255) null,
        "validated_at" timestamptz null
      );
    `);

    this.addSql(`
      alter table "claim"
        add column "circonstances_a" smallint[] null,
        add column "circonstances_b" smallint[] null,
        add column "bareme_version_id" uuid null,
        add column "bareme_code" varchar(32) null,
        add column "vehicle_category_a" varchar(32) null,
        add column "vehicle_category_b" varchar(32) null,
        add column "responsabilite_declaree_a" double precision null,
        add column "responsabilite_declaree_b" double precision null;
    `);

    this.addSql(`
      alter table "match_queue_item"
        add column "responsabilite_a" jsonb null,
        add column "responsabilite_b" jsonb null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "match_queue_item" drop column "responsabilite_a", drop column "responsabilite_b";`);
    this.addSql(`
      alter table "claim"
        drop column "circonstances_a",
        drop column "circonstances_b",
        drop column "bareme_version_id",
        drop column "bareme_code",
        drop column "vehicle_category_a",
        drop column "vehicle_category_b",
        drop column "responsabilite_declaree_a",
        drop column "responsabilite_declaree_b";
    `);
    this.addSql(`drop table if exists "vehicle_category";`);
    this.addSql(`drop table if exists "bareme_case";`);
    this.addSql(`drop table if exists "bareme_version";`);
  }
}
