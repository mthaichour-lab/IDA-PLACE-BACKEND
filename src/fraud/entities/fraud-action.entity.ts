import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

export const FRAUD_ACTION_TYPES = ['APPARIEMENT_MANUEL', 'DELIAGE', 'RELIAGE', 'TRANSMISSION_TARDIVE'] as const;
export type FraudActionType = (typeof FRAUD_ACTION_TYPES)[number];

/**
 * FraudAction — B.9, journal des actions suspectes de place. Deux sources
 * réelles (voir `fraud.service.ts`) :
 *  - `APPARIEMENT_MANUEL`/`DELIAGE`/`RELIAGE` : décisions humaines RÉELLES
 *    de `MatchingService.decide()`, observées via `RealtimeGateway.onEvent
 *    ('match.updated', ...)` (ClaimsModule/MatchingModule ne sont jamais
 *    importés directement — voir ARCHITECTURE.md, interfaces publiques).
 *  - `TRANSMISSION_TARDIVE` : détectée lors du recalcul périodique
 *    (`FraudService.recompute`), à partir du délai réel accident → ingestion
 *    du dossier (`Claim.createdAt`).
 */
@Entity({ tableName: 'fraud_action' })
export class FraudAction {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property({ length: 40 })
  type!: FraudActionType;

  /** Identité de l'auteur (email/id utilisateur pour une décision humaine, code compagnie pour une transmission tardive). */
  @Property()
  actor!: string;

  @Property({ nullable: true, length: 36 })
  claimId?: string;

  @Property({ nullable: true, length: 36 })
  matchId?: string;

  @Property({ type: 'json', nullable: true })
  details?: Record<string, unknown>;

  @Property()
  at: Date = new Date();
}
