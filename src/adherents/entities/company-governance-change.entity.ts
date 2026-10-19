import { Entity, Index, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

/**
 * SEC-04 — demande de changement de GOUVERNANCE d'une compagnie (statut,
 * délais dérogatoires, nature, mode d'alimentation). Proposée par un
 * ADMIN_UAR, appliquée seulement après validation par un AUTRE ADMIN_UAR
 * (règle des quatre yeux), puis scellée au journal avec auteur et valideur.
 */
@Entity({ tableName: 'company_governance_change' })
export class CompanyGovernanceChange {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Index()
  @Property({ length: 36 })
  companyId!: string;

  @Property({ length: 4 })
  companyCode!: string;

  /** Champs de gouvernance demandés (sous-ensemble de `UpdateCompanyGovernanceDto`). */
  @Property({ type: 'json' })
  patch!: Record<string, unknown>;

  @Property({ type: 'text' })
  reason!: string;

  /** EN_ATTENTE → VALIDEE | REJETEE. */
  @Property({ length: 16 })
  status: string = 'EN_ATTENTE';

  @Property()
  requestedById!: string;

  @Property()
  requestedBy!: string;

  @Property()
  requestedAt: Date = new Date();

  @Property({ nullable: true })
  decidedById?: string;

  @Property({ nullable: true })
  decidedBy?: string;

  @Property({ nullable: true })
  decidedAt?: Date;
}
