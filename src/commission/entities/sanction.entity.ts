import { DecimalType, Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { v4 } from 'uuid';

/**
 * Sanction — B.2, écran 7 "Commission" (prononcé de pénalités/sanctions).
 * SEC-32 : une seule sanction par (dossier, compagnie, type), contresignée par
 * un second membre de la place avant d'être prononcée.
 * Rattachée à un `CommissionCase` par id (optionnel : une sanction peut
 * aussi être prononcée hors dossier formel, ex: pénalité de retard
 * administrative — champ libre volontairement nullable).
 */
@Entity({ tableName: 'sanction' })
@Unique({ properties: ['commissionCaseId', 'companyCode', 'type'] })
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

  @Property({ type: new DecimalType('number'), precision: 18, scale: 2, nullable: true })
  amount?: number;

  @Property()
  reason!: string;

  @Property({ onCreate: () => new Date() })
  orderedAt: Date = new Date();

  @Property()
  orderedBy!: string;

  /** SEC-32 : identifiant stable de l'auteur de la proposition. */
  @Property({ nullable: true })
  orderedById?: string;

  /** SEC-32 : `A_CONTRESIGNER` tant qu'un second membre (autre que l'auteur) n'a pas contresigné, puis `PRONONCEE`. */
  @Property({ length: 16 })
  status: string = 'A_CONTRESIGNER';

  @Property({ nullable: true })
  countersignedBy?: string;

  @Property({ nullable: true })
  countersignedById?: string;

  @Property({ nullable: true })
  countersignedAt?: Date;
}
