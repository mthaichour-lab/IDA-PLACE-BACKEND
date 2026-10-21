import { DecimalType, Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';
import { ContestationInfo, OppositionInfo, RecoursHistoryEntry, ResolutionInfo } from '../recours.rules';

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

  /** Référence métier `REC-AAAA-NNNNN`, attribuée à la création par la base et immuable (voir `common/business-ref`). */
  @Property({ length: 20, unique: true, returning: true })
  reference!: string;

  /** Id du `Claim` (ClaimsModule) à l'origine de ce recours — un seul recours par dossier (SEC-20, contrainte `UNIQUE` en base). */
  @Property({ length: 36, unique: true })
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

  /** SEC-06/SEC-34 : `numeric(18,2)`, lu en `number` ; toute arithmétique se fait en centimes (`recours/money.ts`). */
  @Property({ type: new DecimalType('number'), precision: 18, scale: 2 })
  amount!: number;

  /** Forme `ResolutionInfo` (recours.rules.ts) — comment le recours s'est conclu. */
  @Property({ type: 'json', nullable: true })
  resolution?: ResolutionInfo;

  /** SEC-17 : historique des transitions (auteur, rôle, compagnie représentée, motif), jamais réécrit. */
  @Property({ type: 'json' })
  history: RecoursHistoryEntry[] = [];

  /** SEC-33 : verrouillage optimiste — deux transitions concurrentes ne peuvent pas toutes deux réussir. */
  @Property({ version: true })
  version!: number;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date;
}
