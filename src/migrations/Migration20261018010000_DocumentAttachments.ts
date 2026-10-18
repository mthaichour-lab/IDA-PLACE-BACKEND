import { Migration } from '@mikro-orm/migrations';

/**
 * Migration — table `document` (QUESTIONS_UAR.md §9, décision Product Owner
 * 2026-10-18) : premier enregistrement PERSISTÉ de `DocumentsModule`
 * (`src/documents/entities/document.entity.ts`). `recours_id`/
 * `commission_case_id` sont de simples colonnes `varchar` (jamais de clé
 * étrangère MikroORM/SQL) — convention constante de ce code base pour les
 * références croisées entre modules, voir `Migration20260301000000_RecoursSettlementCommission.ts`
 * (`recours.claim_id`, `commission_case.recours_id`, etc.) pour le même choix.
 *
 * Écrite à la main (voir `Migration20260101000000_Initial.ts` et
 * `Migration20261018000000_MatchingConfrontationFields.ts` pour le même
 * choix et sa justification : aucune instance PostgreSQL disponible dans
 * cet environnement de développement pour introspecter le schéma). Le SQL
 * reflète exactement le mapping MikroORM de `Document`.
 */
export class Migration20261018010000_DocumentAttachments extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "document" (
        "id" uuid not null primary key,
        "key" varchar(255) not null,
        "filename" varchar(255) not null,
        "content_type" varchar(255) not null,
        "size_bytes" integer not null,
        "uploaded_by" varchar(255) not null,
        "uploaded_at" timestamptz not null default now(),
        "recours_id" varchar(36) null,
        "commission_case_id" varchar(36) null
      );
      create index "document_recours_id_index" on "document" ("recours_id");
      create index "document_commission_case_id_index" on "document" ("commission_case_id");
      -- Invariant "au plus un de recours_id/commission_case_id" vérifié côté
      -- service (DocumentsService), pas par contrainte CHECK — voir
      -- document.entity.ts.
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "document";');
  }
}
