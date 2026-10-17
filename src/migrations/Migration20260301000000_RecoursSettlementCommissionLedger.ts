import { Migration } from '@mikro-orm/migrations';

/**
 * Migration — tables `recours` (B.3, écran 4), `settlement_monthly` +
 * `compensation_quarter` (B.3, écrans 5/6), `commission_sanction` +
 * `commission_pv` (B.3, écran 7) et `ledger_entry` (B.3, écran 13 —
 * persistance du chaînage SHA-256 déjà réel, auparavant en mémoire
 * uniquement).
 *
 * Écrite à la main (voir `Migration20260101000000_Initial.ts` pour le même
 * choix et sa justification : aucune instance PostgreSQL disponible dans
 * cet environnement de développement). Le SQL reflète exactement le
 * mapping des entités MikroORM des modules `recours`, `settlement`,
 * `commission` et `ledger` (convention de nommage par défaut : snake_case).
 */
export class Migration20260301000000_RecoursSettlementCommissionLedger extends Migration {
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
        "current_deadline_at" timestamptz null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz null
      );
      create index "recours_claim_id_index" on "recours" ("claim_id");
      create index "recours_from_index" on "recours" ("from");
      create index "recours_to_index" on "recours" ("to");
      create index "recours_state_index" on "recours" ("state");
    `);

    this.addSql(`
      create table "settlement_monthly" (
        "id" uuid not null primary key,
        "period" varchar(7) not null,
        "company" varchar(4) not null,
        "claims_settled_count" smallint not null,
        "claims_pending_count" smallint not null,
        "total_settled_amount" double precision not null,
        "total_pending_amount" double precision not null,
        "frais_traitement" double precision not null,
        "status" varchar(255) not null default 'EN_COURS',
        "bordereau_ref" varchar(255) not null,
        "generated_at" timestamptz not null default now(),
        "closed_at" timestamptz null
      );
      create unique index "settlement_monthly_period_company_unique" on "settlement_monthly" ("period", "company");
    `);

    this.addSql(`
      create table "compensation_quarter" (
        "id" uuid not null primary key,
        "quarter" varchar(7) not null,
        "bordereau_ref" varchar(255) not null,
        "positions" jsonb not null,
        "net" jsonb not null,
        "status" varchar(255) not null default 'CALCULE',
        "generated_at" timestamptz not null default now(),
        "sealed_at" timestamptz null
      );
      create unique index "compensation_quarter_quarter_unique" on "compensation_quarter" ("quarter");
    `);

    this.addSql(`
      create table "commission_sanction" (
        "id" uuid not null primary key,
        "recours_id" varchar(36) null,
        "target_company" varchar(4) not null,
        "type" varchar(255) not null,
        "amount" double precision null,
        "reason" text not null,
        "ordered_by" varchar(255) not null,
        "ordered_at" timestamptz not null default now()
      );
      create index "commission_sanction_recours_id_index" on "commission_sanction" ("recours_id");
      create index "commission_sanction_target_company_index" on "commission_sanction" ("target_company");
    `);

    this.addSql(`
      create table "commission_pv" (
        "id" uuid not null primary key,
        "recours_id" varchar(36) null,
        "motif" text not null,
        "decision" text not null,
        "signataires" text[] not null,
        "status" varchar(255) not null default 'SIGNE',
        "created_at" timestamptz not null default now(),
        "signed_at" timestamptz null
      );
      create index "commission_pv_recours_id_index" on "commission_pv" ("recours_id");
    `);

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
    this.addSql('drop table if exists "commission_pv";');
    this.addSql('drop table if exists "commission_sanction";');
    this.addSql('drop table if exists "compensation_quarter";');
    this.addSql('drop table if exists "settlement_monthly";');
    this.addSql('drop table if exists "recours";');
  }
}
