import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/**
 * Référentiel des 69 wilayas — B.3 "Wilaya". Grille de tuiles écran 11
 * (Statistiques de la place) : `cols:13 × rows:8`.
 *
 * ⚠️ Données de coordonnées (col/row/lat/lng) et libellés arabes GÉNÉRÉS
 * pour ce socle (pas de source officielle disponible dans cet
 * environnement) — à VÉRIFIER / remplacer par le référentiel officiel
 * avant mise en production (voir HANDOFF.md). Les codes 01→69 et les noms
 * français sont ceux du découpage administratif algérien standard.
 */
@Entity({ tableName: 'wilaya' })
export class Wilaya {
  @PrimaryKey({ length: 2 })
  code!: string; // "01".."69"

  @Property()
  name!: string;

  @Property({ nullable: true })
  nameAr?: string;

  @Property({ nullable: true })
  region?: string;

  @Property()
  col!: number; // position colonne dans la grille 13x8

  @Property()
  row!: number; // position ligne dans la grille 13x8

  @Property({ type: 'float', nullable: true })
  lat?: number;

  @Property({ type: 'float', nullable: true })
  lng?: number;
}
