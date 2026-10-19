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
