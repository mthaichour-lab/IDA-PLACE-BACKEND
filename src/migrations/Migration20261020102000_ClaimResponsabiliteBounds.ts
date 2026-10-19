import { Migration } from '@mikro-orm/migrations';

/**
 * SEC-49 — bornes de la responsabilité déclarée (colonnes 32-33 de
 * l'import, en %) garanties par la base : 0 à 100 inclus, ou NULL.
 *
 * `NOT VALID` : la contrainte s'applique à toute nouvelle écriture sans
 * bloquer la migration sur d'éventuelles lignes historiques hors bornes
 * (à corriger puis `VALIDATE CONSTRAINT` — voir le rapport de remédiation).
 * L'import refuse déjà ces valeurs en amont (erreur de format).
 */
export class Migration20261020102000_ClaimResponsabiliteBounds extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'alter table "claim" add constraint "claim_responsabilite_declaree_a_check" check ("responsabilite_declaree_a" is null or ("responsabilite_declaree_a" >= 0 and "responsabilite_declaree_a" <= 100)) not valid;',
    );
    this.addSql(
      'alter table "claim" add constraint "claim_responsabilite_declaree_b_check" check ("responsabilite_declaree_b" is null or ("responsabilite_declaree_b" >= 0 and "responsabilite_declaree_b" <= 100)) not valid;',
    );
  }

  override async down(): Promise<void> {
    this.addSql('alter table "claim" drop constraint if exists "claim_responsabilite_declaree_a_check";');
    this.addSql('alter table "claim" drop constraint if exists "claim_responsabilite_declaree_b_check";');
  }
}
