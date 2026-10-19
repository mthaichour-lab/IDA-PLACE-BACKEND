import { Migration } from '@mikro-orm/migrations';

/**
 * Alignement du schéma sur les entités — constaté en phase 2 de la revue
 * sécurité (2026-10-20) en exécutant toutes les migrations sur un
 * PostgreSQL 16 vierge puis `mikro-orm schema:update --dump` :
 *
 *  - `company.correspondent_name|phone|email` : propriétés de l'entité
 *    `Company` (écran 12) jamais créées par une migration — toute écriture
 *    du correspondant échouait (« column does not exist ») ;
 *  - `commission_pv` : entité `CommissionPv` enregistrée mais table jamais
 *    créée (aucune requête ne l'utilise aujourd'hui ; table créée pour que
 *    schéma et métadonnées concordent).
 *
 * Les colonnes `decl_a_id`, `decl_b_id`, `assure_a_identite`,
 * `assure_b_identite` de `match_queue_item` restent telles quelles : c'est
 * l'entité qui fixe désormais `fieldName` (la stratégie de nommage
 * produisait `decl_aid`…, absentes de la base).
 */
export class Migration20261020210000_AlignementSchemaEntites extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'alter table "company" add column if not exists "correspondent_name" varchar(255) null, add column if not exists "correspondent_phone" varchar(255) null, add column if not exists "correspondent_email" varchar(255) null;',
    );
    this.addSql(`
      create table if not exists "commission_pv" (
        "id" uuid not null,
        "recours_id" varchar(36) null,
        "motif" text not null,
        "decision" text not null,
        "signataires" text[] not null,
        "status" varchar(255) not null default 'SIGNE',
        "created_at" timestamptz not null,
        "signed_at" timestamptz null,
        constraint "commission_pv_pkey" primary key ("id")
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "commission_pv";');
    this.addSql('alter table "company" drop column if exists "correspondent_name", drop column if exists "correspondent_phone", drop column if exists "correspondent_email";');
  }
}
