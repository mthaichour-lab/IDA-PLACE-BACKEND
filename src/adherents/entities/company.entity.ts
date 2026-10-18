import { Collection, Entity, Enum, OneToMany, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';
import { Agency } from './agency.entity';

export enum CompanyKind {
  INSURER = 'INSURER',
  MUTUAL = 'MUTUAL',
  SUBSIDIARY = 'SUBSIDIARY',
}

export enum FeedMode {
  ERP = 'ERP',
  ECONSTAT = 'ECONSTAT',
  IMPORT = 'IMPORT',
  API = 'API',
}

export enum CompanyStatus {
  ACTIF = 'ACTIF',
  SUSPENDU = 'SUSPENDU',
  EN_RETRAIT = 'EN_RETRAIT',
  EXCLU = 'EXCLU',
}

/** Adhérent (compagnie) — B.3 "Company". Référentiel de place (écran 12). */
@Entity({ tableName: 'company' })
export class Company {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property({ length: 4, unique: true })
  code!: string;

  @Property()
  name!: string;

  @Property({ nullable: true })
  nameAr?: string;

  /** Couleur de marque (hex) utilisée par `coChip` côté front. */
  @Property()
  color!: string;

  @Enum(() => CompanyKind)
  kind: CompanyKind = CompanyKind.INSURER;

  @Enum(() => FeedMode)
  feedMode: FeedMode = FeedMode.IMPORT;

  /** Jamais la clé en clair : seul le hash est persisté (cf DTO masqué côté API). */
  @Property({ nullable: true, hidden: true })
  apiKeyHash?: string;

  @Enum(() => CompanyStatus)
  status: CompanyStatus = CompanyStatus.ACTIF;

  /** Délais dérogatoires par compagnie (jsonb) — ex: {"recoursDays": 45}. */
  @Property({ type: 'json', nullable: true })
  delayOverrides?: Record<string, unknown>;

  /**
   * Correspondant désigné par l'adhérent (écran 12, référentiel de place)
   * — additif 2026-10-18. Optionnel : aucune identité réelle n'existe dans
   * ce worktree pour les compagnies de démonstration, jamais rempli avec
   * un nom inventé (règle d'or C.1) — `undefined` tant que l'adhérent ne
   * l'a pas renseigné.
   */
  @Property({ nullable: true })
  correspondentName?: string;

  @Property({ nullable: true })
  correspondentPhone?: string;

  @Property({ nullable: true })
  correspondentEmail?: string;

  @OneToMany(() => Agency, (a) => a.company)
  agencies = new Collection<Agency>(this);

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date;
}
