import { Migration } from '@mikro-orm/migrations';

/**
 * SEC-12 — `claim.match_keys` : clés de rapprochement normalisées de chaque
 * déclaration (voir `matchKeysFor`, src/matching/matching.selection.ts) et
 * index GIN, pour que l'appariement charge les seules déclarations
 * partageant une clé (`match_keys && $1`) au lieu de rescorer toute la
 * table à chaque ligne importée.
 *
 * Rétro-alimentation des dossiers existants avec EXACTEMENT la même
 * normalisation que `normalizeMatchValue` (trim, majuscules, espaces et
 * tirets retirés ; e-constat seulement « trimé »). Écrite à la main, comme
 * les migrations précédentes.
 */
export class Migration20261020100000_ClaimMatchKeys extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table "claim" add column "match_keys" text[] null;');
    this.addSql(`
      update "claim" set "match_keys" = array(
        select distinct k from unnest(array[
          'E:' || nullif(btrim("num_econstat"), ''),
          'P:' || nullif(upper(regexp_replace(btrim(coalesce("plate_a", '')), '[[:space:]-]+', '', 'g')), ''),
          'P:' || nullif(upper(regexp_replace(btrim(coalesce("plate_b", '')), '[[:space:]-]+', '', 'g')), ''),
          'N:' || nullif(upper(regexp_replace(btrim(coalesce("police_a", '')), '[[:space:]-]+', '', 'g')), ''),
          'N:' || nullif(upper(regexp_replace(btrim(coalesce("police_b", '')), '[[:space:]-]+', '', 'g')), '')
        ]) as k where k is not null
      );
    `);
    this.addSql('create index "claim_match_keys_gin" on "claim" using gin ("match_keys");');
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "claim_match_keys_gin";');
    this.addSql('alter table "claim" drop column "match_keys";');
  }
}
