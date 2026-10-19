import { Migration } from '@mikro-orm/migrations';

/**
 * Revue sécurité 2026-10-19 — référentiel de place.
 *  - SEC-04 : `company_governance_change` (changements de statut, délais
 *    dérogatoires, nature, alimentation — demandés puis validés par deux
 *    Admin UAR distincts).
 *  - SEC-30 : historique des auteurs (`authors`, jamais écrasé) et révision
 *    sur les référentiels validés à quatre yeux ; trace des corrections de
 *    population. Les lignes existantes reprennent leurs auteurs connus.
 *  - SEC-49 : `expert.rib_last4` (le RIB lui-même est désormais chiffré par
 *    l'application, voir `experts/rib-cipher.ts`).
 */
export class Migration20261020204000_ReferentielGouvernanceTrace extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "company_governance_change" (
        "id" uuid not null primary key,
        "company_id" varchar(36) not null,
        "company_code" varchar(4) not null,
        "patch" jsonb not null,
        "reason" text not null,
        "status" varchar(16) not null default 'EN_ATTENTE',
        "requested_by_id" varchar(255) not null,
        "requested_by" varchar(255) not null,
        "requested_at" timestamptz not null default now(),
        "decided_by_id" varchar(255) null,
        "decided_by" varchar(255) null,
        "decided_at" timestamptz null,
        constraint "company_governance_change_status_check" check ("status" in ('EN_ATTENTE', 'VALIDEE', 'REJETEE')),
        constraint "company_governance_change_four_eyes_check" check ("decided_by_id" is null or "decided_by_id" <> "requested_by_id")
      );
      create index "company_governance_change_company_id_index" on "company_governance_change" ("company_id");
    `);

    for (const table of ['constat_circumstance', 'opposition_motif', 'vehicle_category', 'bareme_version', 'mobile_holiday']) {
      this.addSql(`alter table "${table}" add column "authors" text[] null, add column "revision" integer not null default 1;`);
    }
    for (const table of ['constat_circumstance', 'opposition_motif', 'vehicle_category', 'bareme_version']) {
      this.addSql(`update "${table}" set "authors" = array_remove(array["created_by", "updated_by"], null);`);
    }
    this.addSql(`update "mobile_holiday" set "authors" = array["created_by"];`);
    this.addSql(`
      update "bareme_version" v set "authors" = (
        select array_agg(distinct a) from unnest(v."authors" || coalesce((
          select array_agg(x) from "bareme_case" c, unnest(array_remove(array[c."created_by", c."updated_by"], null)) x where c."version_id" = v."id"
        ), '{}')) a
      );
    `);

    this.addSql(`
      alter table "wilaya_population" add column "updated_by" varchar(255) null, add column "authors" text[] null;
      update "wilaya_population" set "authors" = array["created_by"];
      alter table "expert" add column "rib_last4" varchar(4) null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "expert" drop column "rib_last4";`);
    this.addSql(`alter table "wilaya_population" drop column "updated_by", drop column "authors";`);
    for (const table of ['constat_circumstance', 'opposition_motif', 'vehicle_category', 'bareme_version', 'mobile_holiday']) {
      this.addSql(`alter table "${table}" drop column "authors", drop column "revision";`);
    }
    this.addSql('drop table if exists "company_governance_change";');
  }
}
