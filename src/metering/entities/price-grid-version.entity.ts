import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';
import type { PriceGrid } from '../metering.service';

/**
 * SEC-37 — grille tarifaire PERSISTÉE et VERSIONNÉE : chaque mise à jour
 * crée une nouvelle version avec sa date d'effet (jamais rétroactive) ; les
 * versions précédentes restent inchangées pour recalculer une facture
 * passée. Chaque création est scellée dans le journal (`LedgerService`).
 */
@Entity({ tableName: 'price_grid_version' })
export class PriceGridVersion {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  /** Libellé `TARIF-AAAA.NN`, unique. */
  @Property({ length: 20, unique: true })
  version!: string;

  @Property({ type: 'date' })
  effectiveFrom!: string;

  /** Grille complète (abonnement + inducteurs) de cette version. */
  @Property({ type: 'json' })
  grid!: PriceGrid;

  @Property()
  createdBy!: string;

  @Property()
  createdAt: Date = new Date();
}
