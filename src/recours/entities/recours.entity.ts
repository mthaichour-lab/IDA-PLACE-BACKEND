import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';
import { RecoursState } from '../recours.rules';

export interface RecoursOpposition {
  motif: string;
  at: string;
  by?: string;
}

export interface RecoursContestation {
  motif: string;
  at: string;
  by?: string;
}

/**
 * Recours — B.3, écran 4 "Échanges Annexes 2/3/4". Un recours formel d'une
 * compagnie (`from`) vers une autre (`to`) au sujet d'un dossier (`claimId`,
 * ClaimsModule — référencé par id uniquement, jamais par relation MikroORM :
 * `RecoursModule` n'importe jamais l'entité `Claim`, ARCHITECTURE.md §1).
 *
 * Machine à états + timers conventionnels réels : voir `recours.rules.ts`
 * (fonctions pures testées, `recours.rules.spec.ts`) pour le détail des
 * articles couverts (Art. 10/12/19) et les hypothèses de délais posées.
 */
@Entity({ tableName: 'recours' })
export class Recours {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  /** Id du `Claim` (ClaimsModule) concerné par ce recours. */
  @Property({ length: 36 })
  claimId!: string;

  /** Compagnie à l'origine du recours (code, ex: "CAAT"). */
  @Property({ length: 4 })
  from!: string;

  /** Compagnie destinataire du recours (code). */
  @Property({ length: 4 })
  to!: string;

  @Property()
  state: RecoursState = 'EN_ATTENTE';

  @Property()
  requestSentAt: Date = new Date();

  /** Date de la réponse (opposition) de `to`, si formulée avant l'échéance Art. 10. */
  @Property({ nullable: true })
  responseAt?: Date;

  @Property({ type: 'json', nullable: true })
  opposition?: RecoursOpposition;

  @Property({ type: 'json', nullable: true })
  contestation?: RecoursContestation;

  /** Date d'escalade en commission (manuelle ou automatique — Art. 12). */
  @Property({ nullable: true })
  commissionAt?: Date;

  @Property({ nullable: true })
  settledAt?: Date;

  @Property({ type: 'float' })
  amount!: number;

  /**
   * Échéance courante affichée par le front (countdown Art. 10 ou Art. 12
   * selon l'état) — recalculée/persistée par `RecoursService` à chaque
   * transition. `undefined` pour un état sans timer propre (OPPOSITION) ou
   * définitif (REGLE/FORCLOS/ACCEPTE_TACITE).
   */
  @Property({ nullable: true })
  currentDeadlineAt?: Date;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date;
}
