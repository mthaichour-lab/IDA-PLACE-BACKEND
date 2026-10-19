import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { v4 } from 'uuid';

/** Population de référence d'une wilaya pour une année (décision PO §3) — jamais interpolée ni projetée. */
@Entity({ tableName: 'wilaya_population' })
@Unique({ properties: ['wilayaCode', 'referenceYear'] })
export class WilayaPopulation {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property({ length: 2 })
  wilayaCode!: string;

  @Property({ type: 'integer' })
  referenceYear!: number;

  @Property({ type: 'integer' })
  population!: number;

  /** `RECENSEMENT_RGPH` | `ESTIMATION_ONS` | `AUTRE`. */
  @Property()
  sourceType!: string;

  @Property()
  sourceRef!: string;

  @Property()
  createdBy!: string;

  @Property()
  createdAt: Date = new Date();
}
