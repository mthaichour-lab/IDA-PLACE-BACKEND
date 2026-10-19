import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/** Catégorie de véhicule (décision PO §5) — utilisable sur un dossier seulement au statut `VALIDE_UAR`. */
@Entity({ tableName: 'vehicle_category' })
export class VehicleCategory {
  @PrimaryKey({ length: 32 })
  code!: string;

  @Property()
  label!: string;

  /** `SAISI` | `VALIDE_UAR`. */
  @Property()
  status: string = 'SAISI';

  @Property()
  createdBy!: string;

  /** SEC-30 : identifiants de TOUS les auteurs d'une saisie ou modification (jamais écrasés) — base de la règle des quatre yeux. */
  @Property({ type: 'text[]', nullable: true })
  authors?: string[];

  /** SEC-30 : révision, incrémentée à chaque modification — la validation porte sur une révision précise. */
  @Property({ type: 'integer' })
  revision: number = 1;

  @Property()
  createdAt: Date = new Date();

  @Property({ nullable: true })
  updatedBy?: string;

  @Property({ nullable: true })
  validatedBy?: string;

  @Property({ nullable: true })
  validatedAt?: Date;
}
