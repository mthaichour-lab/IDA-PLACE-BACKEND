import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { v4 } from 'uuid';

/**
 * SettlementMonthly — B.3, écran 5 "Cycle mensuel". Synthèse par compagnie
 * pour UNE période (`period`, format `YYYY-MM`), calculée à partir des
 * `Claims` réels (ClaimsModule — référencé par son service public, jamais
 * par son entité, ARCHITECTURE.md §1) et persistée (un "bordereau" généré
 * est un objet structuré, pas un PDF — voir `settlement.service.ts`).
 */
@Entity({ tableName: 'settlement_monthly' })
@Unique({ properties: ['period', 'company'] })
export class SettlementMonthly {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property({ length: 7 })
  period!: string;

  @Property({ length: 4 })
  company!: string;

  @Property({ type: 'smallint' })
  claimsSettledCount!: number;

  @Property({ type: 'smallint' })
  claimsPendingCount!: number;

  @Property({ type: 'float' })
  totalSettledAmount!: number;

  @Property({ type: 'float' })
  totalPendingAmount!: number;

  /** Frais de traitement dérivés de la grille tarifaire TARIF-2026.01 (MeteringModule) — hypothèse, voir settlement.service.ts. */
  @Property({ type: 'float' })
  fraisTraitement!: number;

  @Property()
  status: string = 'EN_COURS';

  @Property()
  bordereauRef!: string;

  @Property({ onCreate: () => new Date() })
  generatedAt: Date = new Date();

  @Property({ nullable: true })
  closedAt?: Date;
}
