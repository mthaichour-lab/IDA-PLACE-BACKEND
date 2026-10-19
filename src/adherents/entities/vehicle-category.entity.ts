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

  @Property()
  createdAt: Date = new Date();

  @Property({ nullable: true })
  updatedBy?: string;

  @Property({ nullable: true })
  validatedBy?: string;

  @Property({ nullable: true })
  validatedAt?: Date;
}
