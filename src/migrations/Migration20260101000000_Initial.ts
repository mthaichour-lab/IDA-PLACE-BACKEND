import { Migration } from '@mikro-orm/migrations';

/**
 * Migration initiale — tables du référentiel de place (B.3) :
 * `wilaya`, `company`, `agency`, `expert`.
 *
 * Écrite à la main (et non générée par `mikro-orm migration:create`) car
 * aucune instance PostgreSQL n'est disponible dans cet environnement de
 * développement pour introspecter le schéma. Le SQL ci-dessous reflète
 * exactement le mapping des entités MikroORM de `src/adherents` et
 * `src/experts` (convention de nommage par défaut : snake_case).
 *
 * À appliquer avec `npm run migration:up` une fois PostgreSQL disponible
 * (voir docker-compose.yml).
 */
export class Migration20260101000000_Initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wilaya" (
        "code" varchar(2) not null primary key,
        "name" varchar(255) not null,
        "name_ar" varchar(255) null,
        "region" varchar(255) null,
        "col" int not null,
        "row" int not null,
        "lat" double precision null,
        "lng" double precision null
      );
    `);

    this.addSql(`
      create table "company" (
        "id" uuid not null primary key,
        "code" varchar(4) not null unique,
        "name" varchar(255) not null,
        "name_ar" varchar(255) null,
        "color" varchar(255) not null,
        "kind" varchar(255) not null default 'INSURER',
        "feed_mode" varchar(255) not null default 'IMPORT',
        "api_key_hash" varchar(255) null,
        "status" varchar(255) not null default 'ACTIF',
        "delay_overrides" jsonb null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz null
      );
    `);

    this.addSql(`
      create table "agency" (
        "id" uuid not null primary key,
        "company_id" uuid not null references "company" ("id") on update cascade on delete cascade,
        "code" varchar(255) not null,
        "name" varchar(255) not null,
        "type" varchar(255) not null default 'AG',
        "parent_id" uuid null references "agency" ("id") on update cascade on delete set null,
        "wilaya_code" varchar(2) null references "wilaya" ("code") on update cascade on delete set null,
        "manager" varchar(255) null,
        "phone" varchar(255) null,
        "email" varchar(255) null,
        "address" varchar(255) null,
        "status" varchar(255) not null default 'ACTIF',
        "created_at" timestamptz not null default now()
      );
      create index "agency_company_id_index" on "agency" ("company_id");
    `);

    this.addSql(`
      create table "expert" (
        "id" uuid not null primary key,
        "name" varchar(255) not null,
        "firm" varchar(255) null,
        "agrement" varchar(255) null,
        "wilayas" text[] not null default '{}',
        "specialties" text[] not null default '{}',
        "companies" text[] not null default '{}',
        "status" varchar(255) not null default 'ACTIF',
        "rib" varchar(255) null,
        "created_at" timestamptz not null default now()
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "expert";');
    this.addSql('drop table if exists "agency";');
    this.addSql('drop table if exists "company";');
    this.addSql('drop table if exists "wilaya";');
  }
}
