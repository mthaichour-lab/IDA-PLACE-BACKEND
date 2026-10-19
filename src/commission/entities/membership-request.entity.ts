import { Entity, Index, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

/**
 * Demande d'adhésion ou de retrait adressée à l'UAR (Chapitre VI, Art. 30-35).
 * La compagnie est référencée par id (AdherentsModule) ; `companyCode` est
 * dénormalisé pour le scoping tenant, `AuthenticatedUser.companyId` portant
 * le CODE de la compagnie et non son id interne.
 */
@Entity({ tableName: 'membership_request' })
export class MembershipRequest {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  /** Voir `MembershipType` (membership.rules.ts) : ADHESION | RETRAIT. */
  @Property({ length: 16 })
  type!: string;

  /** Voir `MembershipState` (membership.rules.ts). */
  @Property({ length: 16 })
  state!: string;

  @Index()
  @Property({ nullable: true, length: 36 })
  companyId?: string;

  @Index()
  @Property({ nullable: true, length: 4 })
  companyCode?: string;

  @Property({ nullable: true })
  candidateName?: string;

  @Property({ nullable: true })
  agrementRef?: string;

  /** Date de réception du courrier à l'UAR, AAAA-MM-JJ. */
  @Property({ length: 10 })
  receivedAt!: string;

  /** SEC-47 : référence du courrier reçu par l'UAR (traçabilité de la date de réception). */
  @Property({ nullable: true, length: 64 })
  letterRef?: string;

  /** RETRAIT uniquement, AAAA-MM-JJ — voir `computeWithdrawalEffectiveDate`. */
  @Property({ nullable: true, length: 10 })
  effectiveDate?: string;

  @Property({ nullable: true })
  decidedAt?: Date;

  @Property({ nullable: true })
  decidedBy?: string;

  @Property({ type: 'text', nullable: true })
  decisionNote?: string;

  @Property()
  createdBy!: string;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();
}
