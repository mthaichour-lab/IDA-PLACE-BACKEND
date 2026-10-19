import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

export interface IrsamMeasureDefinition {
  startEvent: string;
  endEvent: string;
  scope: string;
}

/** Référence IRSAM (convention de juin 2016, E-Recours) — comparée seulement au statut `VALIDE_UAR` (décision PO §4). */
@Entity({ tableName: 'irsam_benchmark' })
export class IrsamBenchmark {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  /** Voir `IRSAM_INDICATORS`. */
  @Property()
  indicator!: string;

  @Property({ type: 'float' })
  value!: number;

  @Property({ type: 'date' })
  periodFrom!: string;

  @Property({ type: 'date' })
  periodTo!: string;

  @Property({ type: 'json' })
  measureDefinition!: IrsamMeasureDefinition;

  @Property()
  sourceRef!: string;

  /** `SAISI` | `VALIDE_UAR` | `ARCHIVE`. */
  @Property()
  status: string = 'SAISI';

  @Property()
  createdBy!: string;

  @Property()
  createdAt: Date = new Date();

  @Property({ nullable: true })
  validatedBy?: string;

  @Property({ nullable: true })
  validatedAt?: Date;
}
