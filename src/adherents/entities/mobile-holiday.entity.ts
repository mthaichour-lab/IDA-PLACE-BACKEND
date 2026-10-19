import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { v4 } from 'uuid';

/** Férié religieux à date mobile — une ligne par jour chômé (décision PO §2). */
@Entity({ tableName: 'mobile_holiday' })
@Unique({ properties: ['date', 'kind'] })
export class MobileHoliday {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property({ type: 'date' })
  date!: string;

  /** Voir `MOBILE_HOLIDAY_KINDS`. */
  @Property()
  kind!: string;

  @Property({ type: 'integer', nullable: true })
  hijriYear?: number;

  /** `PREVISIONNEL` | `CONFIRME`. */
  @Property()
  status: string = 'PREVISIONNEL';

  /** Référence du communiqué ou du décret — obligatoire dès `CONFIRME`. */
  @Property({ nullable: true })
  sourceRef?: string;

  @Property()
  createdBy!: string;

  @Property()
  createdAt: Date = new Date();

  @Property({ nullable: true })
  confirmedBy?: string;

  @Property({ nullable: true })
  confirmedAt?: Date;
}
