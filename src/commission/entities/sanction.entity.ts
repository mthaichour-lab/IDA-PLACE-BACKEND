import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

/**
 * Sanction — B.2, écran 7 "Commission" (prononcé de pénalités/sanctions).
 * Rattachée à un `CommissionCase` par id (optionnel : une sanction peut
 * aussi être prononcée hors dossier formel, ex: pénalité de retard
 * administrative — champ libre volontairement nullable).
 */
@Entity({ tableName: 'sanction' })
export class Sanction {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property({ nullable: true, length: 36 })
  commissionCaseId?: string;

  @Property({ length: 4 })
  companyCode!: string;

  /** Voir `SanctionType` (commission.rules.ts) : PENALITE_FINANCIERE | AVERTISSEMENT | SUSPENSION. */
  @Property()
  type!: string;

  @Property({ type: 'float', nullable: true })
  amount?: number;

  @Property()
  reason!: string;

  @Property({ onCreate: () => new Date() })
  orderedAt: Date = new Date();

  @Property()
  orderedBy!: string;
}
