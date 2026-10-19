import { Entity, Enum, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

export enum SettlementScope {
  MONTHLY = 'MONTHLY',
  QUARTERLY = 'QUARTERLY',
}

/**
 * SettlementClosure — B.2/B.3, écrans 5 "Cycle mensuel" et 6 "Compensation
 * trimestrielle". Trace la clôture d'une synthèse mensuelle (par compagnie)
 * ou d'une compensation trimestrielle (pour la place entière,
 * `companyCode` absent) — le bordereau associé (`bordereauRef`) est
 * régénérable à l'identique à partir de ces métadonnées + des `Recours`
 * réglés de la période (voir `SettlementService`).
 *
 * N'est volontairement PAS dans B.3 (qui ne détaille pas cette entité) :
 * ajout additionnel documenté (voir HANDOFF.md), nécessaire pour qu'une
 * clôture survive un redémarrage et ne soit jamais rejouée deux fois.
 *
 * SEC-19/SEC-20 : unicité garantie en base par l'index unique
 * `(scope, period, coalesce(company_code, ''))` (expression non exprimable
 * en décorateur — voir `Migration20261020202000_UniciteRecoursCommissionClotures`).
 */
@Entity({ tableName: 'settlement_closure' })
export class SettlementClosure {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Enum(() => SettlementScope)
  scope!: SettlementScope;

  /** "2026-01" (mensuel) ou "2026-Q1" (trimestriel). */
  @Property()
  period!: string;

  /** Code compagnie (clôture mensuelle uniquement) ; absent pour une clôture trimestrielle (place entière). */
  @Property({ nullable: true, length: 4 })
  companyCode?: string;

  @Property()
  bordereauRef!: string;

  @Property({ onCreate: () => new Date() })
  closedAt: Date = new Date();

  /** Nom affiché de l'auteur — jamais renvoyé aux rôles compagnie (SEC-26). */
  @Property()
  closedBy!: string;

  /** SEC-17/19 : identifiant stable de l'auteur de la clôture. */
  @Property({ nullable: true })
  closedById?: string;

  /** SEC-19 : instantané immuable (recours retenus, montants) figé à la clôture — les lectures d'une période close s'y réfèrent. */
  @Property({ type: 'json', nullable: true })
  snapshot?: Record<string, unknown>;

  /** SEC-19 : SHA-256 de la sérialisation canonique de `snapshot`, scellé au journal. */
  @Property({ length: 64, nullable: true })
  snapshotHash?: string;
}
