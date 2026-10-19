import { Migration } from '@mikro-orm/migrations';

/**
 * Référentiels de place — décisions PO points 1 à 4 : fériés mobiles,
 * circonstances du constat, motifs d'opposition, populations par wilaya,
 * référence IRSAM, périmètre des wilayas (`effective_from`, `parent_code`).
 *
 * Écrite à la main (aucune instance PostgreSQL pour introspecter le schéma,
 * voir Migration20261018010000_DocumentAttachments.ts). Seules les données
 * d'origine (a)/(b) sont insérées : `mobile_holiday`, `wilaya_population` et
 * `irsam_benchmark` restent vides.
 */
export class Migration20261018030000_ReferentielPlace extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wilaya" add column "effective_from" date null, add column "parent_code" varchar(2) null;
    `);

    this.addSql(`
      create table "mobile_holiday" (
        "id" uuid not null primary key,
        "date" date not null,
        "kind" varchar(255) not null,
        "hijri_year" integer null,
        "status" varchar(255) not null default 'PREVISIONNEL',
        "source_ref" varchar(255) null,
        "created_by" varchar(255) not null,
        "created_at" timestamptz not null default now(),
        "confirmed_by" varchar(255) null,
        "confirmed_at" timestamptz null,
        constraint "mobile_holiday_date_kind_unique" unique ("date", "kind")
      );
    `);

    this.addSql(`
      create table "constat_circumstance" (
        "number" smallint not null primary key,
        "label_fr" varchar(255) not null,
        "label_ar" varchar(255) null,
        "status" varchar(255) not null default 'STANDARD_A_CONFIRMER',
        "created_by" varchar(255) not null,
        "updated_by" varchar(255) null,
        "validated_by" varchar(255) null,
        "validated_at" timestamptz null
      );
    `);

    this.addSql(`
      create table "opposition_motif" (
        "code" varchar(64) not null primary key,
        "label" varchar(255) not null,
        "forbidden" boolean not null default false,
        "source_ref" varchar(255) null,
        "status" varchar(255) not null default 'SAISI',
        "created_by" varchar(255) not null,
        "created_at" timestamptz not null default now(),
        "updated_by" varchar(255) null,
        "validated_by" varchar(255) null,
        "validated_at" timestamptz null
      );
    `);

    this.addSql(`
      create table "wilaya_population" (
        "id" uuid not null primary key,
        "wilaya_code" varchar(2) not null,
        "reference_year" integer not null,
        "population" integer not null,
        "source_type" varchar(255) not null,
        "source_ref" varchar(255) not null,
        "created_by" varchar(255) not null,
        "created_at" timestamptz not null default now(),
        constraint "wilaya_population_wilaya_code_reference_year_unique" unique ("wilaya_code", "reference_year")
      );
    `);

    this.addSql(`
      create table "irsam_benchmark" (
        "id" uuid not null primary key,
        "indicator" varchar(255) not null,
        "value" double precision not null,
        "period_from" date not null,
        "period_to" date not null,
        "measure_definition" jsonb not null,
        "source_ref" varchar(255) not null,
        "status" varchar(255) not null default 'SAISI',
        "created_by" varchar(255) not null,
        "created_at" timestamptz not null default now(),
        "validated_by" varchar(255) null,
        "validated_at" timestamptz null
      );
      create index "irsam_benchmark_indicator_status_index" on "irsam_benchmark" ("indicator", "status");
    `);

    // Origine (b) : constat européen (modèle CEA) — copie figée de CONSTAT_CIRCUMSTANCES_SEED.
    this.addSql(`
      insert into "constat_circumstance" ("number", "label_fr", "status", "created_by") values
        (1, 'en stationnement / à l''arrêt', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (2, 'quittait un stationnement / ouvrait une portière', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (3, 'prenait un stationnement', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (4, 'sortait d''un parking, d''un lieu privé, d''un chemin de terre', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (5, 's''engageait dans un parking, un lieu privé, un chemin de terre', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (6, 's''engageait sur une place à sens giratoire', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (7, 'roulait sur une place à sens giratoire', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (8, 'heurtait à l''arrière, en roulant dans le même sens et sur une même file', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (9, 'roulait dans le même sens et sur une file différente', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (10, 'changeait de file', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (11, 'doublait', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (12, 'virait à droite', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (13, 'virait à gauche', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (14, 'reculait', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (15, 'empiétait sur une voie réservée à la circulation en sens inverse', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (16, 'venait de droite (dans un carrefour)', 'STANDARD_A_CONFIRMER', 'system:seed'),
        (17, 'n''avait pas observé un signal de priorité ou un feu rouge', 'STANDARD_A_CONFIRMER', 'system:seed');
    `);

    // Origine (a) : guide pédagogique UAR, diapo 10 — copie figée de OPPOSITION_MOTIFS_SEED.
    this.addSql(`
      insert into "opposition_motif" ("code", "label", "forbidden", "source_ref", "status", "created_by") values
        ('NON_DECLARATION', 'Non-déclaration du sinistre', true, 'Guide pédagogique UAR, diapo 10 (Art. 10)', 'SAISI', 'system:seed');
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "irsam_benchmark";');
    this.addSql('drop table if exists "wilaya_population";');
    this.addSql('drop table if exists "opposition_motif";');
    this.addSql('drop table if exists "constat_circumstance";');
    this.addSql('drop table if exists "mobile_holiday";');
    this.addSql('alter table "wilaya" drop column if exists "effective_from", drop column if exists "parent_code";');
  }
}
