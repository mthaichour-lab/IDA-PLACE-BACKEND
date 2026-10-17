import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';
import { ContestationInfo, OppositionInfo, ResolutionInfo } from '../recours.rules';

/**
 * Recours — B.3, écran 4 "Échanges Annexes 2/3/4". Une ligne = un recours
 * inter-compagnies (Annexe 2) introduit par la compagnie `from` (assureur de
 * l'adhérent IDA) à l'encontre de la compagnie `to` (adverse), pour le
 * dossier `claimId` (ClaimsModule — référencé par id uniquement, jamais par
 * relation MikroORM : les modules ne partagent que des interfaces publiques,
 * voir ARCHITECTURE.md).
 *
 * `state` suit la machine d'état pure de `recours.rules.ts` (timers
 * conventionnels Art.10/12/19) ; stocké en texte simple (comme `Claim.state`)
 * plutôt qu'en `@Enum` MikroORM, pour ne pas dupliquer l'union de types déjà
 * définie côté règles pures.
 */
@Entity({ tableName: 'recours' })
export class Recours {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  /** Id du `Claim` (ClaimsModule) à l'origine de ce recours. */
  @Property({ length: 36 })
  claimId!: string;

  /** Compagnie demanderesse (assureur IDA de l'assuré indemnisé). */
  @Property({ length: 4 })
  from!: string;

  /** Compagnie adverse (débitrice potentielle). */
  @Property({ length: 4 })
  to!: string;

  /** Voir `RecoursState` (recours.rules.ts). */
  @Property()
  state: string = 'EN_ATTENTE';

  @Property()
  requestSentAt: Date = new Date();

  @Property({ nullable: true })
  responseAt?: Date;

  /** Forme `OppositionInfo` (recours.rules.ts) — Art.12. */
  @Property({ type: 'json', nullable: true })
  opposition?: OppositionInfo;

  /** Forme `ContestationInfo` (recours.rules.ts). */
  @Property({ type: 'json', nullable: true })
  contestation?: ContestationInfo;

  @Property({ nullable: true })
  commissionAt?: Date;

  /** Date de règlement effectif (compensation — SettlementModule), distincte de `responseAt`. */
  @Property({ nullable: true })
  settledAt?: Date;

  @Property({ type: 'float' })
  amount!: number;

  /** Forme `ResolutionInfo` (recours.rules.ts) — comment le recours s'est conclu. */
  @Property({ type: 'json', nullable: true })
  resolution?: ResolutionInfo;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date;
}
