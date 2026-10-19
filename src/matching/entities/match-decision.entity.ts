import { Entity, Index, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

/**
 * SEC-28 — historique des décisions de confrontation (écran 2) : chaque
 * décision humaine (confirm, reject, complement, link) est conservée avec
 * son auteur (nom, id, rôle, compagnie), l'état avant/après et son motif.
 * Ajout seul : une re-décision crée une nouvelle ligne, jamais une mise à
 * jour — on sait qui a décidé et ce qui a changé.
 */
@Entity({ tableName: 'match_decision' })
@Index({ properties: ['matchId', 'decidedAt'] })
export class MatchDecision {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  /** Ligne de file (`MatchQueueItem.id`) décidée. */
  @Property({ type: 'uuid' })
  matchId!: string;

  @Property({ length: 16 })
  action!: string;

  @Property({ length: 20 })
  previousStatus!: string;

  @Property({ length: 20 })
  newStatus!: string;

  @Property({ nullable: true, length: 500 })
  reason?: string;

  @Property({ type: 'uuid', nullable: true })
  linkDeclId?: string;

  @Property()
  decidedBy!: string;

  @Property()
  decidedById!: string;

  @Property({ length: 32 })
  decidedByRole!: string;

  /** Compagnie de l'auteur, absente pour un rôle place. */
  @Property({ nullable: true, length: 8 })
  decidedByCompany?: string;

  @Property()
  decidedAt: Date = new Date();
}
