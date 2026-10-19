import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/** Case du constat amiable (1-17) — base du barème Art. 14 (décision PO §1). */
@Entity({ tableName: 'constat_circumstance' })
export class ConstatCircumstance {
  @PrimaryKey({ type: 'smallint', autoincrement: false })
  number!: number;

  @Property()
  labelFr!: string;

  @Property({ nullable: true })
  labelAr?: string;

  /** `STANDARD_A_CONFIRMER` | `VALIDE_UAR`. */
  @Property()
  status: string = 'STANDARD_A_CONFIRMER';

  @Property()
  createdBy!: string;

  @Property({ nullable: true })
  updatedBy?: string;

  @Property({ nullable: true })
  validatedBy?: string;

  @Property({ nullable: true })
  validatedAt?: Date;
}
