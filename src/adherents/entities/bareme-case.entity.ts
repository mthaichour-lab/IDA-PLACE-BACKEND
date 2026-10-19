import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { v4 } from 'uuid';

/** Cas du barème Art. 14 : parts de responsabilité A/B en %, `partA + partB = 100`. */
@Entity({ tableName: 'bareme_case' })
@Unique({ properties: ['versionId', 'code'] })
export class BaremeCase {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property({ type: 'uuid' })
  versionId!: string;

  @Property({ length: 32 })
  code!: string;

  @Property()
  label!: string;

  @Property({ type: 'smallint' })
  partA!: number;

  @Property({ type: 'smallint' })
  partB!: number;

  @Property()
  createdBy!: string;

  @Property()
  createdAt: Date = new Date();

  @Property({ nullable: true })
  updatedBy?: string;
}
