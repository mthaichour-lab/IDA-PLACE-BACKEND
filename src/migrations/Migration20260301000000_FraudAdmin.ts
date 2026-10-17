import { Migration } from '@mikro-orm/migrations';

/**
 * Migration — sprint 3 : tables `fraud_case`/`fraud_action` (B.3/B.9,
 * FraudModule réel) et `place_user` (B.3, AdminModule.users réel).
 *
 * Écrite à la main (même justification que les migrations précédentes :
 * aucune instance PostgreSQL disponible dans cet environnement de
 * développement pour introspecter le schéma). Le SQL reflète exactement
 * le mapping des entités MikroORM de `src/fraud` et `src/admin`.
 */
export class Migration20260301000000_FraudAdmin extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "fraud_case" (
        "id" uuid not null primary key,
        "dedupe_key" varchar(512) not null unique,
        "type" varchar(40) not null,
        "score" smallint not null,
        "severity" varchar(10) not null,
        "claim_ids" text[] not null default '{}',
        "companies_involved" text[] not null default '{}',
        "details" jsonb not null,
        "detected_at" timestamptz not null default now(),
        "updated_at" timestamptz null
      );
      create index "fraud_case_type_index" on "fraud_case" ("type");
      create index "fraud_case_severity_index" on "fraud_case" ("severity");
    `);

    this.addSql(`
      create table "fraud_action" (
        "id" uuid not null primary key,
        "type" varchar(40) not null,
        "actor" varchar(255) not null,
        "claim_id" varchar(36) null,
        "match_id" varchar(36) null,
        "details" jsonb null,
        "at" timestamptz not null default now()
      );
      create index "fraud_action_type_index" on "fraud_action" ("type");
      create index "fraud_action_claim_id_index" on "fraud_action" ("claim_id");
    `);

    this.addSql(`
      create table "place_user" (
        "id" uuid not null primary key,
        "name" varchar(255) not null,
        "email" varchar(255) not null unique,
        "role" varchar(40) not null,
        "company_id" varchar(255) null,
        "active" boolean not null default true,
        "grant" text[] not null default '{}',
        "revoke" text[] not null default '{}',
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz null
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "place_user";');
    this.addSql('drop table if exists "fraud_action";');
    this.addSql('drop table if exists "fraud_case";');
  }
}
