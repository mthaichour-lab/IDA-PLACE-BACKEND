import { CompanyKind, CompanyStatus, FeedMode } from './entities/company.entity';
import { AgencyType } from './entities/agency.entity';

/**
 * Jeu de données déterministe utilisé UNIQUEMENT en mode dégradé (PostgreSQL
 * injoignable) pour que l'écran 12 (Référentiel) reste utilisable en
 * développement sans base. Jamais utilisé si la base répond.
 * SEC-44 : identifiants au format UUID, comme en base (les routes valident
 * désormais `:id` par `ParseUUIDPipe`).
 */
export const MEMORY_IDS = {
  CAAT: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca01',
  SAA: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca02',
  CASH: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca03',
  ALLI: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca04',
  TALA: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca05',
  AGENCY_CAAT_DG: '3b6f2c1e-0c1a-4a7e-8a01-0000000000a1',
  AGENCY_CAAT_ORAN: '3b6f2c1e-0c1a-4a7e-8a01-0000000000a2',
  AGENCY_SAA_DG: '3b6f2c1e-0c1a-4a7e-8a01-0000000000a3',
  AGENCY_SAA_SETIF: '3b6f2c1e-0c1a-4a7e-8a01-0000000000a4',
} as const;
export interface MemoryCompany {
  id: string;
  /** Fixée à la création (ou au démarrage pour le seed) : une lecture ne doit pas la modifier. */
  createdAt?: string;
  code: string;
  name: string;
  nameAr?: string;
  color: string;
  kind: CompanyKind;
  feedMode: FeedMode;
  apiKeyMasked: string;
  status: CompanyStatus;
  withdrawalEffectiveDate?: string;
  delayOverrides?: Record<string, unknown>;
  correspondentName?: string;
  correspondentPhone?: string;
  correspondentEmail?: string;
}

export interface MemoryAgency {
  id: string;
  companyId: string;
  code: string;
  name: string;
  type: AgencyType;
  parentId?: string;
  wilayaCode?: string;
  manager?: string;
  phone?: string;
  email?: string;
  address?: string;
  status: CompanyStatus;
}

/** Date de création des compagnies du seed mémoire : figée au chargement du module. */
export const MEMORY_SEED_AT = new Date().toISOString();

export const MEMORY_COMPANIES: MemoryCompany[] = [
  { id: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca01', code: 'CAAT', name: 'CAAT Assurance', color: '#1F4FA3', kind: CompanyKind.INSURER, feedMode: FeedMode.API, apiKeyMasked: 'sk_live_•••••3f2a', status: CompanyStatus.ACTIF },
  { id: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca02', code: 'SAA', name: 'SAA Assurances', color: '#C99A06', kind: CompanyKind.INSURER, feedMode: FeedMode.ERP, apiKeyMasked: 'sk_live_•••••91bd', status: CompanyStatus.ACTIF },
  { id: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca03', code: 'CASH', name: 'CASH Assurances', color: '#24786D', kind: CompanyKind.INSURER, feedMode: FeedMode.ECONSTAT, apiKeyMasked: 'sk_live_•••••0e77', status: CompanyStatus.ACTIF },
  { id: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca04', code: 'ALLI', name: 'Alliance Assurances', color: '#D92F2E', kind: CompanyKind.INSURER, feedMode: FeedMode.IMPORT, apiKeyMasked: 'sk_live_•••••c412', status: CompanyStatus.ACTIF },
  { id: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca05', code: 'TALA', name: 'Talanis', color: '#5EBAAE', kind: CompanyKind.MUTUAL, feedMode: FeedMode.IMPORT, apiKeyMasked: 'sk_live_•••••9ab1', status: CompanyStatus.SUSPENDU },
];

export const MEMORY_AGENCIES: MemoryAgency[] = [
  { id: '3b6f2c1e-0c1a-4a7e-8a01-0000000000a1', companyId: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca01', code: 'DG-01', name: 'Direction Générale CAAT', type: AgencyType.DG, wilayaCode: '16', status: CompanyStatus.ACTIF },
  { id: '3b6f2c1e-0c1a-4a7e-8a01-0000000000a2', companyId: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca01', code: 'AG-31-01', name: 'CAAT Oran Centre', type: AgencyType.AG, parentId: '3b6f2c1e-0c1a-4a7e-8a01-0000000000a1', wilayaCode: '31', status: CompanyStatus.ACTIF },
  { id: '3b6f2c1e-0c1a-4a7e-8a01-0000000000a3', companyId: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca02', code: 'DG-01', name: 'Direction Générale SAA', type: AgencyType.DG, wilayaCode: '16', status: CompanyStatus.ACTIF },
  { id: '3b6f2c1e-0c1a-4a7e-8a01-0000000000a4', companyId: '3b6f2c1e-0c1a-4a7e-8c01-00000000ca02', code: 'AG-19-01', name: 'SAA Sétif', type: AgencyType.AG, parentId: '3b6f2c1e-0c1a-4a7e-8a01-0000000000a3', wilayaCode: '19', status: CompanyStatus.ACTIF },
];
