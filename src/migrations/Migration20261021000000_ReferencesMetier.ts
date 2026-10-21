import { Migration } from '@mikro-orm/migrations';

/**
 * Références métier lisibles, séquentielles et immuables — voir
 * `src/common/business-ref/business-ref.ts` :
 *
 *  - `recours.reference` : `REC-AAAA-NNNNN` (année de `created_at`) ;
 *  - `commission_case.reference` : `CSC-AAAA-NNN` (année de `created_at`),
 *    et `commission_case.recours_reference`, dénormalisée depuis le recours
 *    comme `claim_id`/`company_a`/`company_b` ;
 *  - `match_queue_item.reference` : `MAT-AAMMJJ-NNN` (jour de `at`).
 *
 * 1. `business_ref_counter` : un compteur par (type, période). La fonction
 *    `next_business_ref(kind, at)` l'incrémente par `INSERT … ON CONFLICT DO
 *    UPDATE … RETURNING` — atomique, sans course entre créations
 *    concurrentes ; le verrou de ligne tenu jusqu'à la fin de la transaction
 *    sérialise les créations d'une même période (numérotation sans trou
 *    quand l'appel a lieu dans la transaction de création). Une SEQUENCE
 *    PostgreSQL ne convient pas : elle ne repart pas à 1 à chaque année (ou
 *    chaque jour pour MAT) sans DDL, et un `nextval` annulé laisse un trou.
 *    Les périodes sont lues à l'heure d'Alger.
 * 2. Reprise de l'existant dans l'ordre chronologique (`created_at`/`at`,
 *    puis `id`) avec la même fonction : les compteurs continuent ensuite.
 * 3. Déclencheurs : toute insertion sans référence en reçoit une (filet de
 *    sécurité, l'application l'attribue elle-même) ; toute modification
 *    d'une référence déjà posée est refusée (immuabilité).
 * 4. `NOT NULL` + `UNIQUE` sur chaque référence.
 */
export class Migration20261021000000_ReferencesMetier extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "business_ref_counter" (
        "kind" varchar(3) not null check ("kind" in ('REC', 'CSC', 'MAT')),
        "period" varchar(6) not null,
        "last_value" integer not null check ("last_value" > 0),
        constraint "business_ref_counter_pkey" primary key ("kind", "period")
      );
    `);

    this.addSql(`
      create or replace function "next_business_ref"(p_kind text, p_at timestamptz) returns text language plpgsql as $$
      declare
        v_local timestamp := coalesce(p_at, now()) at time zone 'Africa/Algiers';
        v_period text;
        v_width integer;
        v_n integer;
      begin
        case p_kind
          when 'REC' then v_period := to_char(v_local, 'YYYY'); v_width := 5;
          when 'CSC' then v_period := to_char(v_local, 'YYYY'); v_width := 3;
          when 'MAT' then v_period := to_char(v_local, 'YYMMDD'); v_width := 3;
          else raise exception 'type de référence métier inconnu : %', p_kind using errcode = '22023';
        end case;
        insert into "business_ref_counter" as c ("kind", "period", "last_value") values (p_kind, v_period, 1)
          on conflict ("kind", "period") do update set "last_value" = c."last_value" + 1
          returning c."last_value" into v_n;
        return p_kind || '-' || v_period || '-' || case when length(v_n::text) >= v_width then v_n::text else lpad(v_n::text, v_width, '0') end;
      end $$;
    `);

    this.addSql('alter table "recours" add column "reference" varchar(20) null;');
    this.addSql('alter table "commission_case" add column "reference" varchar(20) null, add column "recours_reference" varchar(20) null;');
    this.addSql('alter table "match_queue_item" add column "reference" varchar(20) null;');

    // Reprise chronologique : la numérotation de l'existant suit l'ordre de création.
    this.addSql(`
      do $$
      declare r record;
      begin
        for r in select "id", "created_at" from "recours" order by "created_at", "id" loop
          update "recours" set "reference" = next_business_ref('REC', r."created_at") where "id" = r."id";
        end loop;
        for r in select "id", "created_at" from "commission_case" order by "created_at", "id" loop
          update "commission_case" set "reference" = next_business_ref('CSC', r."created_at") where "id" = r."id";
        end loop;
        for r in select "id", "at" from "match_queue_item" order by "at", "id" loop
          update "match_queue_item" set "reference" = next_business_ref('MAT', r."at") where "id" = r."id";
        end loop;
      end $$;
    `);
    this.addSql('update "commission_case" c set "recours_reference" = r."reference" from "recours" r where r."id"::text = c."recours_id";');

    this.addSql('alter table "recours" alter column "reference" set not null;');
    this.addSql('alter table "commission_case" alter column "reference" set not null;');
    this.addSql('alter table "match_queue_item" alter column "reference" set not null;');
    this.addSql('alter table "recours" add constraint "recours_reference_unique" unique ("reference");');
    this.addSql('alter table "commission_case" add constraint "commission_case_reference_unique" unique ("reference");');
    this.addSql('alter table "match_queue_item" add constraint "match_queue_item_reference_unique" unique ("reference");');

    // TG_ARGV[0] = type, TG_ARGV[1] = colonne horodatée qui fixe la période.
    this.addSql(`
      create or replace function "business_ref_assign"() returns trigger language plpgsql as $$
      begin
        if new."reference" is null then
          new."reference" := next_business_ref(tg_argv[0], (to_jsonb(new) ->> tg_argv[1])::timestamptz);
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create or replace function "business_ref_immutable"() returns trigger language plpgsql as $$
      begin
        if new."reference" is distinct from old."reference" then
          raise exception 'référence métier immuable sur % (%)', tg_table_name, old."reference" using errcode = '23514';
        end if;
        return new;
      end $$;
    `);
    for (const [table, kind, column] of [
      ['recours', 'REC', 'created_at'],
      ['commission_case', 'CSC', 'created_at'],
      ['match_queue_item', 'MAT', 'at'],
    ]) {
      this.addSql(`create trigger "${table}_reference_assign" before insert on "${table}" for each row execute function "business_ref_assign"('${kind}', '${column}');`);
      this.addSql(`create trigger "${table}_reference_immutable" before update of "reference" on "${table}" for each row execute function "business_ref_immutable"();`);
    }

    this.addSql(`
      do $$
      begin
        if exists (select 1 from pg_roles where rolname = 'ida_place_app') then
          execute 'grant select, insert, update on "business_ref_counter" to ida_place_app';
        end if;
      end $$;
    `);
  }

  /** Protégé par `npm run migration:down` (SEC-51). Les références attribuées sont perdues : à ne rejouer qu'en développement. */
  override async down(): Promise<void> {
    for (const table of ['recours', 'commission_case', 'match_queue_item']) {
      this.addSql(`drop trigger if exists "${table}_reference_immutable" on "${table}";`);
      this.addSql(`drop trigger if exists "${table}_reference_assign" on "${table}";`);
    }
    this.addSql('drop function if exists "business_ref_immutable"();');
    this.addSql('drop function if exists "business_ref_assign"();');
    this.addSql('alter table "match_queue_item" drop column if exists "reference";');
    this.addSql('alter table "commission_case" drop column if exists "reference", drop column if exists "recours_reference";');
    this.addSql('alter table "recours" drop column if exists "reference";');
    this.addSql('drop function if exists "next_business_ref"(text, timestamptz);');
    this.addSql('drop table if exists "business_ref_counter";');
  }
}
