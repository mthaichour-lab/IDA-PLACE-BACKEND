import { Migration } from '@mikro-orm/migrations';

/**
 * Migration — colonnes additives sur `match_queue_item` (écran 2 "Vue de
 * confrontation", B.5) : une valeur par déclaration (A/B), dénormalisées
 * depuis `ClaimMatchInput` au même recalcul que `criteria` (voir
 * `matching.service.ts` `applyComputed`) pour les cartes "Véhicule A/B" et
 * les champs de confrontation (date d'accident, wilaya, canal) — affichage
 * uniquement, aucun impact sur le score/niveau AUTO/MANUEL/NON.
 *
 * Écrite à la main (voir `Migration20260101000000_Initial.ts`) : aucune
 * instance PostgreSQL disponible dans cet environnement de développement
 * pour introspecter le schéma.
 */
export class Migration20261018000000_MatchingConfrontationFields extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "match_queue_item"
        add column "accident_date_a" date null,
        add column "accident_date_b" date null,
        add column "wilaya_a" varchar(2) null,
        add column "wilaya_b" varchar(2) null,
        add column "assure_a_identite" varchar(255) null,
        add column "assure_b_identite" varchar(255) null,
        add column "canal_declaration_a" varchar(255) null,
        add column "canal_declaration_b" varchar(255) null,
        add column "police_a" varchar(255) null,
        add column "police_b" varchar(255) null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "match_queue_item"
        drop column "accident_date_a",
        drop column "accident_date_b",
        drop column "wilaya_a",
        drop column "wilaya_b",
        drop column "assure_a_identite",
        drop column "assure_b_identite",
        drop column "canal_declaration_a",
        drop column "canal_declaration_b",
        drop column "police_a",
        drop column "police_b";
    `);
  }
}
