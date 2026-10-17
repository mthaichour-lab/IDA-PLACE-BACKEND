import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';
import { FraudCaseType, FraudSeverity } from '../fraud.detection';

/**
 * FraudCase — B.3/B.9, écran 9 "Anti-fraude". Un cas suspect RÉELLEMENT
 * détecté (voir `fraud.detection.ts` pour les 5 règles). `dedupeKey` permet
 * un recalcul périodique idempotent (upsert) : `${type}:${claimIds triés}`,
 * pour qu'un même cas ne soit jamais dupliqué à chaque `GET /fraud/cases`.
 */
@Entity({ tableName: 'fraud_case' })
export class FraudCase {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property({ unique: true, length: 512 })
  dedupeKey!: string;

  @Property({ length: 40 })
  type!: FraudCaseType;

  @Property({ type: 'smallint' })
  score!: number;

  @Property({ length: 10 })
  severity!: FraudSeverity;

  @Property({ type: 'text[]' })
  claimIds: string[] = [];

  @Property({ type: 'text[]' })
  companiesInvolved: string[] = [];

  @Property({ type: 'json' })
  details!: Record<string, unknown>;

  @Property({ onCreate: () => new Date() })
  detectedAt: Date = new Date();

  @Property({ onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date;
}
