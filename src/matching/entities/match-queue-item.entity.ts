import { Entity, Enum, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';
import { MatchCriteriaResult } from '../matching.scoring';

export enum MatchLevel {
  AUTO = 'AUTO',
  MANUEL = 'MANUEL',
  NON = 'NON',
}

export enum MatchStatus {
  A_CONFIRMER = 'A_CONFIRMER',
  AUTO_CONFIRME = 'AUTO_CONFIRME',
  CONFIRME_MANUEL = 'CONFIRME_MANUEL',
  REJETE = 'REJETE',
  COMPLEMENT = 'COMPLEMENT',
}

/**
 * MatchQueueItem — B.3/B.5, écran 2 "Confrontation & matching".
 *
 * Une ligne par déclaration A candidate (`declAId`), appariée ou non avec
 * sa meilleure contrepartie `declBId` trouvée par `MatchingService`
 * (clé exacte e-constat, sinon clé composite + score pondéré — B.5).
 * Ne référence PAS l'entité `Claim` par relation MikroORM (ARCHITECTURE.md :
 * les modules ne partagent que des interfaces publiques) : seuls les id
 * (uuid, string) et les champs dénormalisés nécessaires à l'écran 2 sont
 * stockés ici — exactement la forme de `MatchQueueItemDto` (contrat stable).
 */
@Entity({ tableName: 'match_queue_item' })
export class MatchQueueItem {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  /** Id du `Claim` (ClaimsModule) porté par cette ligne. */
  @Property({ length: 36 })
  declAId!: string;

  @Property({ nullable: true, length: 36 })
  declBId?: string;

  @Property()
  refA!: string;

  @Property({ length: 4 })
  companyA!: string;

  @Property()
  plateA!: string;

  @Property({ nullable: true })
  refB?: string;

  @Property({ nullable: true, length: 4 })
  companyB?: string;

  @Property({ nullable: true })
  plateB?: string;

  @Property({ type: 'smallint' })
  score!: number;

  @Enum(() => MatchLevel)
  level!: MatchLevel;

  @Enum(() => MatchStatus)
  status: MatchStatus = MatchStatus.A_CONFIRMER;

  @Property()
  econstatShared: boolean = false;

  /** Critères pondérés (B.5) — forme `MatchCriteriaDto`. */
  @Property({ type: 'json' })
  criteria!: MatchCriteriaResult;

  @Property({ nullable: true })
  confirmedBy?: string;

  @Property({ nullable: true })
  confirmedAt?: Date;

  @Property({ nullable: true })
  rejectReason?: string;

  /** Id de la déclaration liée manuellement (action=link), si différente de `declBId`. */
  @Property({ nullable: true, length: 36 })
  linkedDeclId?: string;

  @Property({ onCreate: () => new Date() })
  at: Date = new Date();

  @Property({ onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date;
}
