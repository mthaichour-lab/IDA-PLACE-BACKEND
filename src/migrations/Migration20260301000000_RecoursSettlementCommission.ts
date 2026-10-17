import { Migration } from '@mikro-orm/migrations';

/**
 * Migration — tables `recours` (B.3, écran 4), `settlement_closure`
 * (B.2/B.3, écrans 5/6 — entité additionnelle documentée dans HANDOFF.md),
 * `commission_case` et `sanction` (B.2, écran 7 — entités additionnelles
 * documentées dans HANDOFF.md).
 *
 * Écrite à la main (voir `Migration20260101000000_Initial.ts` et
 * `Migration20260201000000_ClaimsMatching.ts` pour le même choix et sa
 * justification : aucune instance PostgreSQL disponible dans cet
 * environnement de développement pour introspecter le schéma). Le SQL
 * reflète exactement le mapping des entités MikroORM de `src/recours`,
 * `src/settlement` et `src/commission` (convention de nommage par défaut :
 * snake_case).
 */
export class Migration20260301000000_RecoursSettlementCommission extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "recours" (
        "id" uuid not null primary key,
        "claim_id" varchar(36) not null,
        "from" varchar(4) not null,
        "to" varchar(4) not null,
        "state" varchar(255) not null default 'EN_ATTENTE',
        "request_sent_at" timestamptz not null default now(),
        "response_at" timestamptz null,
        "opposition" jsonb null,
        "contestation" jsonb null,
        "commission_at" timestamptz null,
        "settled_at" timestamptz null,
        "amount" double precision not null,
        "resolution" jsonb null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz null
      );
      create index "recours_claim_id_index" on "recours" ("claim_id");
      create index "recours_from_index" on "recours" ("from");
      create index "recours_to_index" on "recours" ("to");
      create index "recours_state_index" on "recours" ("state");
      create index "recours_request_sent_at_index" on "recours" ("request_sent_at");
    `);

    this.addSql(`
      create table "settlement_closure" (
        "id" uuid not null primary key,
        "scope" varchar(255) not null,
        "period" varchar(255) not null,
        "company_code" varchar(4) null,
        "bordereau_ref" varchar(255) not null,
        "closed_at" timestamptz not null default now(),
        "closed_by" varchar(255) not null
      );
      create index "settlement_closure_scope_period_index" on "settlement_closure" ("scope", "period");
      -- Unicité applicative (scope, period, company_code) vérifiée côté
      -- service (NULL n'est pas comparable par unicité SQL standard sur
      -- une clôture trimestrielle, où company_code est absent).
    `);

    this.addSql(`
      create table "commission_case" (
        "id" uuid not null primary key,
        "recours_id" varchar(36) not null,
        "claim_id" varchar(36) not null,
        "company_a" varchar(4) not null,
        "company_b" varchar(4) not null,
        "amount" double precision not null,
        "motif" varchar(255) not null,
        "status" varchar(255) not null default 'A_INSTRUIRE',
        "scheduled_at" timestamptz not null default now(),
        "decided_at" timestamptz null,
        "decision" jsonb null,
        "pv" jsonb null,
        "created_at" timestamptz not null default now()
      );
      create index "commission_case_recours_id_index" on "commission_case" ("recours_id");
      create index "commission_case_status_index" on "commission_case" ("status");
    `);

    this.addSql(`
      create table "sanction" (
        "id" uuid not null primary key,
        "commission_case_id" varchar(36) null,
        "company_code" varchar(4) not null,
        "type" varchar(255) not null,
        "amount" double precision null,
        "reason" varchar(255) not null,
        "ordered_at" timestamptz not null default now(),
        "ordered_by" varchar(255) not null
      );
      create index "sanction_commission_case_id_index" on "sanction" ("commission_case_id");
      create index "sanction_company_code_index" on "sanction" ("company_code");
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "sanction";');
    this.addSql('drop table if exists "commission_case";');
    this.addSql('drop table if exists "settlement_closure";');
    this.addSql('drop table if exists "recours";');
  }
}
