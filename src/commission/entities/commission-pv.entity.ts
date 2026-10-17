import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';

/**
 * CommissionPv — B.3, écran 7 "Commission". Procès-verbal de commission,
 * objet structuré (motif/décision/signataires) — pas un PDF (la génération
 * d'un document imprimable reste du ressort de `DocumentsModule`, hors
 * périmètre de ce sprint). Lié à un recours escaladé (`recoursId`,
 * RecoursModule) par id uniquement.
 */
@Entity({ tableName: 'commission_pv' })
export class CommissionPv {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property({ nullable: true, length: 36 })
  recoursId?: string;

  @Property({ type: 'text' })
  motif!: string;

  @Property({ type: 'text' })
  decision!: string;

  /** Noms des signataires (membres de la commission). */
  @Property({ type: 'text[]' })
  signataires!: string[];

  @Property()
  status: string = 'SIGNE';

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ nullable: true })
  signedAt?: Date;
}
