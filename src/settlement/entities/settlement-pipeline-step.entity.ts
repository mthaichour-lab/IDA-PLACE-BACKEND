import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { v4 } from 'uuid';

/**
 * Réalisation d'une étape manuelle de l'avancement du lot trimestriel
 * (écran 6, Diagramme 2) — voir `settlement-pipeline.rules.ts`. L'étape
 * `PV_REGLEMENT` n'est jamais persistée ici : elle découle de la
 * `SettlementClosure` QUARTERLY.
 */
@Entity({ tableName: 'settlement_pipeline_step' })
@Unique({ properties: ['period', 'step'] })
export class SettlementPipelineStep {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  /** "2026-Q1". */
  @Property({ length: 7 })
  period!: string;

  /** Voir `PipelineStep` (settlement-pipeline.rules.ts). */
  @Property({ length: 32 })
  step!: string;

  @Property({ onCreate: () => new Date() })
  completedAt: Date = new Date();

  @Property()
  completedBy!: string;

  @Property({ type: 'text', nullable: true })
  note?: string;
}
