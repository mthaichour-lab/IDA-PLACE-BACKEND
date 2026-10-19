import { Entity, Enum, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

export enum ExpertStatus {
  ACTIF = 'ACTIF',
  SUSPENDU = 'SUSPENDU',
  RADIE = 'RADIE',
}

/** Expert de place (registre) — B.3 "Expert". Référentiel (écran 12). */
@Entity({ tableName: 'expert' })
export class Expert {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property()
  name!: string;

  @Property({ nullable: true })
  firm?: string;

  @Property({ nullable: true })
  agrement?: string;

  @Property({ type: 'array' })
  wilayas: string[] = [];

  @Property({ type: 'array' })
  specialties: string[] = [];

  /** Codes des compagnies pour lesquelles l'expert intervient. */
  @Property({ type: 'array' })
  companies: string[] = [];

  @Enum(() => ExpertStatus)
  status: ExpertStatus = ExpertStatus.ACTIF;

  /** SEC-49 : RIB chiffré (AES-256-GCM, `experts/rib-cipher.ts`), jamais en clair ni renvoyé par l'API. */
  @Property({ nullable: true, hidden: true })
  rib?: string;

  /** Quatre derniers caractères du RIB, pour l'affichage masqué aux rôles place. */
  @Property({ nullable: true, length: 4 })
  ribLast4?: string;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();
}
