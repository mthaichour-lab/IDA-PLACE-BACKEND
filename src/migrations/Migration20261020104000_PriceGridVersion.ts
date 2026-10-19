import { Migration } from '@mikro-orm/migrations';

/**
 * SEC-37 — `price_grid_version` : grille tarifaire persistée et versionnée
 * (date d'effet, auteur). La grille TARIF-2026.01 du dossier technique
 * reste la version de référence tant qu'aucune version n'est enregistrée
 * (voir `MeteringService`).
 */
export class Migration20261020104000_PriceGridVersion extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "price_grid_version" (
        "id" uuid not null,
        "version" varchar(20) not null,
        "effective_from" date not null,
        "grid" jsonb not null,
        "created_by" varchar(255) not null,
        "created_at" timestamptz not null,
        constraint "price_grid_version_pkey" primary key ("id"),
        constraint "price_grid_version_version_unique" unique ("version")
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "price_grid_version";');
  }
}
