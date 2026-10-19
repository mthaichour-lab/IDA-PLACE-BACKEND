import { Migration } from '@mikro-orm/migrations';

/**
 * SEC-28 — historique des décisions de confrontation (`match_decision`,
 * ajout seul) et compagnie de l'auteur de la dernière décision sur la ligne
 * (`match_queue_item.confirmed_by_company`, pour masquer le nom d'un agent
 * d'une autre compagnie, SEC-26).
 */
export class Migration20261020103000_MatchDecisionHistory extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "match_decision" (
        "id" uuid not null,
        "match_id" uuid not null,
        "action" varchar(16) not null,
        "previous_status" varchar(20) not null,
        "new_status" varchar(20) not null,
        "reason" varchar(500) null,
        "link_decl_id" uuid null,
        "decided_by" varchar(255) not null,
        "decided_by_id" varchar(255) not null,
        "decided_by_role" varchar(32) not null,
        "decided_by_company" varchar(8) null,
        "decided_at" timestamptz not null,
        constraint "match_decision_pkey" primary key ("id")
      );
    `);
    this.addSql('create index "match_decision_match_id_decided_at_index" on "match_decision" ("match_id", "decided_at");');
    this.addSql('alter table "match_queue_item" add column "confirmed_by_company" varchar(8) null;');
  }

  override async down(): Promise<void> {
    this.addSql('alter table "match_queue_item" drop column "confirmed_by_company";');
    this.addSql('drop table if exists "match_decision";');
  }
}
