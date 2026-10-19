import { Migration } from '@mikro-orm/migrations';

/**
 * Revue sécurité 2026-10-19 — recours, commission, compensation, adhésions.
 *
 *  - SEC-06/SEC-34 : montants `double precision` → `numeric(18,2)` (arrondis
 *    au centime à la conversion ; l'arithmétique applicative se fait en
 *    centimes entiers, voir `recours/money.ts`).
 *  - SEC-17 : `recours.history` (auteur, rôle, compagnie représentée, motif de
 *    chaque transition).
 *  - SEC-33 : colonnes de version (verrouillage optimiste) sur `recours` et
 *    `commission_case`.
 *  - SEC-32 : sanctions contresignées (`status`, contresignataire) ; les
 *    sanctions existantes sont réputées prononcées.
 *  - SEC-19 : instantané figé et hash d'une clôture, auteur par identifiant.
 *  - SEC-47 : référence du courrier d'une demande d'adhésion/retrait.
 */
export class Migration20261020200000_MontantsHistoriqueVerrouillage extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "recours"
        alter column "amount" type numeric(18,2) using round("amount"::numeric, 2),
        add column "history" jsonb not null default '[]',
        add column "version" integer not null default 1;

      alter table "commission_case"
        alter column "amount" type numeric(18,2) using round("amount"::numeric, 2),
        add column "version" integer not null default 1;

      alter table "sanction"
        alter column "amount" type numeric(18,2) using round("amount"::numeric, 2),
        add column "ordered_by_id" varchar(255) null,
        add column "status" varchar(16) not null default 'PRONONCEE',
        add column "countersigned_by" varchar(255) null,
        add column "countersigned_by_id" varchar(255) null,
        add column "countersigned_at" timestamptz null;
      -- Les sanctions antérieures sont réputées prononcées ; les nouvelles attendent un contreseing.
      alter table "sanction" alter column "status" set default 'A_CONTRESIGNER';

      alter table "settlement_closure"
        add column "closed_by_id" varchar(255) null,
        add column "snapshot" jsonb null,
        add column "snapshot_hash" varchar(64) null;

      alter table "membership_request" add column "letter_ref" varchar(64) null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "membership_request" drop column "letter_ref";
      alter table "settlement_closure" drop column "closed_by_id", drop column "snapshot", drop column "snapshot_hash";
      alter table "sanction"
        drop column "ordered_by_id", drop column "status", drop column "countersigned_by", drop column "countersigned_by_id", drop column "countersigned_at",
        alter column "amount" type double precision using "amount"::double precision;
      alter table "commission_case" drop column "version", alter column "amount" type double precision using "amount"::double precision;
      alter table "recours" drop column "history", drop column "version", alter column "amount" type double precision using "amount"::double precision;
    `);
  }
}
