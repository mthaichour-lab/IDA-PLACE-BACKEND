import { Migration } from '@mikro-orm/migrations';

/**
 * Tables `membership_request` (adhésions/retraits, Chapitre VI Art. 30-35)
 * et `settlement_pipeline_step` (avancement du lot trimestriel, Diagramme 2).
 * Écrite à la main comme les précédentes ; `company_id` reste une simple
 * colonne `varchar` (références croisées entre modules par id uniquement).
 */
export class Migration20261018020000_MembershipSettlementPipeline extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "membership_request" (
        "id" uuid not null primary key,
        "type" varchar(16) not null,
        "state" varchar(16) not null,
        "company_id" varchar(36) null,
        "company_code" varchar(4) null,
        "candidate_name" varchar(255) null,
        "agrement_ref" varchar(255) null,
        "received_at" varchar(10) not null,
        "effective_date" varchar(10) null,
        "decided_at" timestamptz null,
        "decided_by" varchar(255) null,
        "decision_note" text null,
        "created_by" varchar(255) not null,
        "created_at" timestamptz not null default now()
      );
      create index "membership_request_company_id_index" on "membership_request" ("company_id");
      create index "membership_request_company_code_index" on "membership_request" ("company_code");

      create table "settlement_pipeline_step" (
        "id" uuid not null primary key,
        "period" varchar(7) not null,
        "step" varchar(32) not null,
        "completed_at" timestamptz not null default now(),
        "completed_by" varchar(255) not null,
        "note" text null
      );
      alter table "settlement_pipeline_step" add constraint "settlement_pipeline_step_period_step_unique" unique ("period", "step");
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "settlement_pipeline_step";');
    this.addSql('drop table if exists "membership_request";');
  }
}
