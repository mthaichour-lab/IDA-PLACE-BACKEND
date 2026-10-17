import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

export interface CommissionDecisionInfo {
  outcome: 'RECOURS_FONDE' | 'RECOURS_REJETE';
  motif?: string;
}

export interface CommissionPvInfo {
  signedBy: string;
  signedAt: string;
  ref: string;
}

/**
 * CommissionCase — B.2, écran 7 "Commission". Dossier de conciliation ouvert
 * sur un `Recours` (RecoursModule — référencé par id uniquement, jamais par
 * relation MikroORM, voir ARCHITECTURE.md) une fois celui-ci transmis en
 * commission (`transmettre_commission`). `claimId`/`companyA`/`companyB`/
 * `amount` sont dénormalisés depuis le recours à la création (lecture seule
 * via `RecoursService`, voir `commission.service.ts`), pour l'affichage sans
 * dépendance croisée au moment de la lecture.
 *
 * N'est pas décrite nommément dans B.3 (qui ne détaille que `Recours` et
 * `Invoice`) — entité additionnelle documentée (voir HANDOFF.md),
 * nécessaire pour une file de conciliation réelle (écran 7).
 */
@Entity({ tableName: 'commission_case' })
export class CommissionCase {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property({ length: 36 })
  recoursId!: string;

  @Property({ length: 36 })
  claimId!: string;

  @Property({ length: 4 })
  companyA!: string;

  @Property({ length: 4 })
  companyB!: string;

  @Property({ type: 'float' })
  amount!: number;

  @Property()
  motif!: string;

  /** Voir `CommissionCaseStatus` (commission.rules.ts). */
  @Property()
  status: string = 'A_INSTRUIRE';

  @Property()
  scheduledAt: Date = new Date();

  @Property({ nullable: true })
  decidedAt?: Date;

  @Property({ type: 'json', nullable: true })
  decision?: CommissionDecisionInfo;

  @Property({ type: 'json', nullable: true })
  pv?: CommissionPvInfo;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();
}
