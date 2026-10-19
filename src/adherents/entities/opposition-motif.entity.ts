import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/** Motif d'opposition (Annexe 3) — `forbidden` : ne peut jamais motiver une opposition (décision PO §1). */
@Entity({ tableName: 'opposition_motif' })
export class OppositionMotif {
  @PrimaryKey({ length: 64 })
  code!: string;

  @Property()
  label!: string;

  @Property()
  forbidden: boolean = false;

  @Property({ nullable: true })
  sourceRef?: string;

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
