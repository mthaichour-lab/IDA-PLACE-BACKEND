import { Migration } from '@mikro-orm/migrations';

/**
 * SEC-10 — `document.owner_company` : compagnie de l'uploadeur, base du
 * contrôle d'accès des pièces non attachées (téléchargement par id, plus
 * jamais par clé fournie par le client). Rétro-alimentée depuis le préfixe
 * des clés existantes (`<compagnie>/…` ; `place/…` = rôle place, NULL).
 */
export class Migration20261020101000_DocumentOwnerCompany extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table "document" add column "owner_company" varchar(8) null;');
    this.addSql(`update "document" set "owner_company" = split_part("key", '/', 1) where split_part("key", '/', 1) not in ('', 'place') and length(split_part("key", '/', 1)) <= 8;`);
  }

  override async down(): Promise<void> {
    this.addSql('alter table "document" drop column "owner_company";');
  }
}
