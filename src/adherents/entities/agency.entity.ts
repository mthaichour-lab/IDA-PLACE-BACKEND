import { Entity, Enum, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';
import { Company, CompanyStatus } from './company.entity';
import { Wilaya } from './wilaya.entity';

export enum AgencyType {
  DG = 'DG',
  DR = 'DR',
  AG = 'AG',
}

/** Agence d'une compagnie — B.3 "Agency". Référentiel de place (écran 12). */
@Entity({ tableName: 'agency' })
export class Agency {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @ManyToOne(() => Company)
  company!: Company;

  @Property()
  code!: string;

  @Property()
  name!: string;

  @Enum(() => AgencyType)
  type: AgencyType = AgencyType.AG;

  /** Agence parente (hiérarchie DG > DR > AG). */
  @ManyToOne(() => Agency, { nullable: true })
  parent?: Agency;

  @ManyToOne(() => Wilaya, { nullable: true })
  wilaya?: Wilaya;

  @Property({ nullable: true })
  manager?: string;

  @Property({ nullable: true })
  phone?: string;

  @Property({ nullable: true })
  email?: string;

  @Property({ nullable: true })
  address?: string;

  @Enum(() => CompanyStatus)
  status: CompanyStatus = CompanyStatus.ACTIF;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();
}
