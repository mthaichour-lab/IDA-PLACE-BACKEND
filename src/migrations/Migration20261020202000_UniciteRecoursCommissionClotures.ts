import { Migration } from '@mikro-orm/migrations';

/**
 * SEC-20 (et SEC-19, SEC-32) — l'unicité « un seul X par Y » est garantie par
 * la base, plus seulement par un contrôle applicatif en mémoire (deux requêtes
 * simultanées passaient toutes les deux) :
 *  - un recours par dossier : `UNIQUE(recours.claim_id)` ;
 *  - un dossier de commission par recours : `UNIQUE(commission_case.recours_id)` ;
 *  - une clôture par (portée, période, compagnie) : index unique sur
 *    `(scope, period, coalesce(company_code, ''))` (une clôture trimestrielle
 *    n'a pas de compagnie : un NULL n'est pas comparable par une contrainte
 *    UNIQUE standard) ;
 *  - une seule demande de RETRAIT reçue par compagnie : index unique partiel ;
 *  - une sanction par (dossier, compagnie, type).
 * L'application traduit la violation (23505) en 409.
 *
 * Nettoyage SÛR des doublons existants : rien n'est supprimé sans copie.
 * Pour chaque groupe, la ligne la plus ancienne est conservée ; les autres
 * sont COPIÉES dans une table d'archive `<table>_doublon_sec20` (avec la
 * date d'archivage) avant d'être retirées de la table — elles restent
 * consultables pour arbitrage par l'UAR. Les demandes de retrait en double ne
 * sont pas déplacées mais ANNULÉES (état `ANNULEE`, motif explicite).
 * `down()` retire les contraintes ; il ne réinjecte pas les doublons archivés.
 */
export class Migration20261020202000_UniciteRecoursCommissionClotures extends Migration {
  private archiveDuplicates(table: string, partition: string, order: string): void {
    const archive = `${table}_doublon_sec20`;
    this.addSql(`create table if not exists "${archive}" as select * from "${table}" where false;`);
    this.addSql(`alter table "${archive}" add column if not exists "archived_at" timestamptz not null default now();`);
    this.addSql(`
      insert into "${archive}"
      select t.*, now() from "${table}" t
      where t."id" in (
        select "id" from (
          select "id", row_number() over (partition by ${partition} order by ${order}) as rn from "${table}"
        ) ranked where ranked.rn > 1
      );
    `);
    this.addSql(`delete from "${table}" where "id" in (select "id" from "${archive}");`);
  }

  override async up(): Promise<void> {
    this.archiveDuplicates('recours', '"claim_id"', '"request_sent_at", "created_at", "id"');
    this.archiveDuplicates('commission_case', '"recours_id"', '"created_at", "id"');
    this.archiveDuplicates('settlement_closure', '"scope", "period", coalesce("company_code", \'\')', '"closed_at", "id"');
    this.archiveDuplicates('sanction', '"commission_case_id", "company_code", "type"', '"ordered_at", "id"');

    this.addSql(`
      update "membership_request" m
      set "state" = 'ANNULEE',
          "decided_at" = now(),
          "decided_by" = 'migration SEC-20',
          "decision_note" = 'Doublon de demande de retrait annulé par la migration SEC-20 (une seule demande reçue par compagnie).'
      where m."id" in (
        select "id" from (
          select "id", row_number() over (partition by "company_id" order by "created_at", "id") as rn
          from "membership_request" where "type" = 'RETRAIT' and "state" = 'RECUE'
        ) ranked where ranked.rn > 1
      );
    `);

    this.addSql(`
      drop index if exists "recours_claim_id_index";
      alter table "recours" add constraint "recours_claim_id_unique" unique ("claim_id");

      drop index if exists "commission_case_recours_id_index";
      alter table "commission_case" add constraint "commission_case_recours_id_unique" unique ("recours_id");

      create unique index "settlement_closure_scope_period_company_unique"
        on "settlement_closure" ("scope", "period", (coalesce("company_code", '')));

      create unique index "membership_request_retrait_recue_unique"
        on "membership_request" ("company_id") where "type" = 'RETRAIT' and "state" = 'RECUE';

      alter table "sanction" add constraint "sanction_commission_case_id_company_code_type_unique" unique ("commission_case_id", "company_code", "type");
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "sanction" drop constraint if exists "sanction_commission_case_id_company_code_type_unique";
      drop index if exists "membership_request_retrait_recue_unique";
      drop index if exists "settlement_closure_scope_period_company_unique";
      alter table "commission_case" drop constraint if exists "commission_case_recours_id_unique";
      create index if not exists "commission_case_recours_id_index" on "commission_case" ("recours_id");
      alter table "recours" drop constraint if exists "recours_claim_id_unique";
      create index if not exists "recours_claim_id_index" on "recours" ("claim_id");
    `);
  }
}
