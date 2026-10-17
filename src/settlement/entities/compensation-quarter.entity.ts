import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { v4 } from 'uuid';

export interface BilateralPosition {
  from: string;
  to: string;
  amount: number;
}

export interface NetPosition {
  company: string;
  net: number;
}

/**
 * CompensationQuarter — B.3, écran 6 "Compensation trimestrielle". Matrice
 * des positions bilatérales entre compagnies (qui doit à qui, `positions`)
 * et compensation multilatérale qui en résulte (net à payer/recevoir par
 * compagnie, `net`) — voir `settlement.service.ts` pour l'algorithme et
 * l'hypothèse de calcul des positions à partir des `Claims` réglés.
 */
@Entity({ tableName: 'compensation_quarter' })
@Unique({ properties: ['quarter'] })
export class CompensationQuarter {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property({ length: 7 })
  quarter!: string;

  @Property()
  bordereauRef!: string;

  @Property({ type: 'json' })
  positions!: BilateralPosition[];

  @Property({ type: 'json' })
  net!: NetPosition[];

  @Property()
  status: string = 'CALCULE';

  @Property({ onCreate: () => new Date() })
  generatedAt: Date = new Date();

  @Property({ nullable: true })
  sealedAt?: Date;
}
