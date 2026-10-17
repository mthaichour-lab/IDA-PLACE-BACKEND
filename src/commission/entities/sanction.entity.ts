import { Entity, Enum, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

export enum SanctionType {
  PENALITE = 'PENALITE',
  SANCTION = 'SANCTION',
}

/**
 * Sanction — B.3, écran 7 "Commission". Historique des pénalités/sanctions
 * prononcées par la commission, chacune éventuellement liée à un recours
 * escaladé (`recoursId` — RecoursModule, référencé par id uniquement,
 * jamais par relation MikroORM, ARCHITECTURE.md §1). Append par nature
 * (une ligne par décision) : constitue l'historique demandé par la
 * mission (§3), pas de mise à jour applicative d'une ligne existante.
 */
@Entity({ tableName: 'commission_sanction' })
export class Sanction {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  /** Id du `Recours` (RecoursModule) à l'origine, si applicable. */
  @Property({ nullable: true, length: 36 })
  recoursId?: string;

  /** Compagnie visée par la pénalité/sanction (code). */
  @Property({ length: 4 })
  targetCompany!: string;

  @Enum(() => SanctionType)
  type!: SanctionType;

  /** Montant de la pénalité (DA) — non pertinent pour une sanction non monétaire (ex: avertissement). */
  @Property({ type: 'float', nullable: true })
  amount?: number;

  @Property({ type: 'text' })
  reason!: string;

  @Property()
  orderedBy!: string;

  @Property({ onCreate: () => new Date() })
  orderedAt: Date = new Date();
}
