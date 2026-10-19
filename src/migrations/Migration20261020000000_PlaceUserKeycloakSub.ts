import { Migration } from '@mikro-orm/migrations';

/**
 * SEC-09/SEC-24 (revue sécurité 2026-10-19) — liaison du compte applicatif
 * `place_user` à l'identité Keycloak (`sub`), renseignée à la première
 * authentification dont l'e-mail est vérifié. Ensuite, la résolution se fait
 * par `sub` : un autre compte Keycloak présentant le même e-mail est refusé.
 *
 * Écrite à la main (même convention que les migrations précédentes).
 */
export class Migration20261020000000_PlaceUserKeycloakSub extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table "place_user" add column "keycloak_sub" varchar(255) null;');
    this.addSql('create unique index "place_user_keycloak_sub_unique" on "place_user" ("keycloak_sub");');
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "place_user_keycloak_sub_unique";');
    this.addSql('alter table "place_user" drop column if exists "keycloak_sub";');
  }
}
