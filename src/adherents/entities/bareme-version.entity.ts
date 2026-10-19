import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

/** Version du barème Art. 14 (décision PO §5) — immuable dès `VALIDE_UAR` : corriger = nouvelle version. */
@Entity({ tableName: 'bareme_version' })
export class BaremeVersion {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property({ length: 128, unique: true })
  label!: string;

  /** `BROUILLON` | `VALIDE_UAR` | `ARCHIVE`. */
  @Property()
  status: string = 'BROUILLON';

  @Property({ nullable: true })
  sourceRef?: string;

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
