import { Migration } from '@mikro-orm/migrations';

/**
 * Migration — tables `claim` (B.3 "Claim/Declaration", B.4 modèle 47
 * colonnes) et `match_queue_item` (B.3, B.5 file de confrontation).
 *
 * Écrite à la main (voir `Migration20260101000000_Initial.ts` pour le même
 * choix et sa justification : aucune instance PostgreSQL disponible dans
 * cet environnement de développement pour introspecter le schéma). Le SQL
 * reflète exactement le mapping des entités MikroORM de `src/claims` et
 * `src/matching` (convention de nommage par défaut : snake_case).
 */
export class Migration20260201000000_ClaimsMatching extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "claim" (
        "id" uuid not null primary key,
        "num_econstat" varchar(255) null,
        "company" varchar(4) not null,
        "counterparty_company" varchar(4) null,
        "accident_date" date null,
        "accident_time" varchar(5) null,
        "wilaya" varchar(2) null,
        "commune" varchar(255) null,
        "gps_lat" double precision null,
        "gps_lng" double precision null,
        "plate_a" varchar(255) null,
        "plate_b" varchar(255) null,
        "police_a" varchar(255) null,
        "police_b" varchar(255) null,
        "nombre_vehicules" smallint null,
        "territoire" varchar(255) null,
        "dommages_corporels_declares" boolean null,
        "adverse_partie_adherente" boolean null,
        "adverse_partie_active" boolean null,
        "estimated_amount" double precision null,
        "expert_amount" double precision null,
        "exclusions" text[] null,
        "pieces_fournies" text[] null,
        "constat_amiable_signe_deux_parties" boolean null,
        "date_demande_recours" date null,
        "canal_declaration" varchar(255) null,
        "state" varchar(255) not null default 'RECU',
        "eligibility_verdict" varchar(255) null,
        "eligibility_reasons" text[] null,
        "raw" jsonb not null,
        "source_file" varchar(255) null,
        "created_at" timestamptz not null default now()
      );
      create index "claim_num_econstat_index" on "claim" ("num_econstat");
      create index "claim_company_index" on "claim" ("company");
      create index "claim_wilaya_index" on "claim" ("wilaya");
      create index "claim_accident_date_index" on "claim" ("accident_date");
      create index "claim_state_index" on "claim" ("state");
    `);

    this.addSql(`
      create table "match_queue_item" (
        "id" uuid not null primary key,
        "decl_a_id" varchar(36) not null,
        "decl_b_id" varchar(36) null,
        "ref_a" varchar(255) not null,
        "company_a" varchar(4) not null,
        "plate_a" varchar(255) not null,
        "ref_b" varchar(255) null,
        "company_b" varchar(4) null,
        "plate_b" varchar(255) null,
        "score" smallint not null,
        "level" varchar(255) not null,
        "status" varchar(255) not null default 'A_CONFIRMER',
        "econstat_shared" boolean not null default false,
        "criteria" jsonb not null,
        "confirmed_by" varchar(255) null,
        "confirmed_at" timestamptz null,
        "reject_reason" varchar(255) null,
        "linked_decl_id" varchar(36) null,
        "at" timestamptz not null default now(),
        "updated_at" timestamptz null
      );
      create unique index "match_queue_item_decl_a_id_unique" on "match_queue_item" ("decl_a_id");
      create index "match_queue_item_decl_b_id_index" on "match_queue_item" ("decl_b_id");
      create index "match_queue_item_status_index" on "match_queue_item" ("status");
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "match_queue_item";');
    this.addSql('drop table if exists "claim";');
  }
}
