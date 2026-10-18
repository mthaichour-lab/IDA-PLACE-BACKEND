import { CompanyKind, CompanyStatus, FeedMode } from './entities/company.entity';
import { AgencyType } from './entities/agency.entity';

/**
 * Jeu de données déterministe utilisé UNIQUEMENT en mode dégradé (PostgreSQL
 * injoignable) pour que l'écran 12 (Référentiel) reste utilisable en
 * développement sans base. Jamais utilisé si la base répond.
 */
export interface MemoryCompany {
  id: string;
  code: string;
  name: string;
  nameAr?: string;
  color: string;
  kind: CompanyKind;
  feedMode: FeedMode;
  apiKeyMasked: string;
  status: CompanyStatus;
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

export const MEMORY_COMPANIES: MemoryCompany[] = [
  { id: 'c-caat', code: 'CAAT', name: 'CAAT Assurance', color: '#1F4FA3', kind: CompanyKind.INSURER, feedMode: FeedMode.API, apiKeyMasked: 'sk_live_•••••3f2a', status: CompanyStatus.ACTIF },
  { id: 'c-saa', code: 'SAA', name: 'SAA Assurances', color: '#C99A06', kind: CompanyKind.INSURER, feedMode: FeedMode.ERP, apiKeyMasked: 'sk_live_•••••91bd', status: CompanyStatus.ACTIF },
  { id: 'c-cash', code: 'CASH', name: 'CASH Assurances', color: '#24786D', kind: CompanyKind.INSURER, feedMode: FeedMode.ECONSTAT, apiKeyMasked: 'sk_live_•••••0e77', status: CompanyStatus.ACTIF },
  { id: 'c-alli', code: 'ALLI', name: 'Alliance Assurances', color: '#D92F2E', kind: CompanyKind.INSURER, feedMode: FeedMode.IMPORT, apiKeyMasked: 'sk_live_•••••c412', status: CompanyStatus.ACTIF },
  { id: 'c-tala', code: 'TALA', name: 'Talanis', color: '#5EBAAE', kind: CompanyKind.MUTUAL, feedMode: FeedMode.IMPORT, apiKeyMasked: 'sk_live_•••••9ab1', status: CompanyStatus.SUSPENDU },
];

export const MEMORY_AGENCIES: MemoryAgency[] = [
  { id: 'a-caat-dg', companyId: 'c-caat', code: 'DG-01', name: 'Direction Générale CAAT', type: AgencyType.DG, wilayaCode: '16', status: CompanyStatus.ACTIF },
  { id: 'a-caat-oran', companyId: 'c-caat', code: 'AG-31-01', name: 'CAAT Oran Centre', type: AgencyType.AG, parentId: 'a-caat-dg', wilayaCode: '31', status: CompanyStatus.ACTIF },
  { id: 'a-saa-dg', companyId: 'c-saa', code: 'DG-01', name: 'Direction Générale SAA', type: AgencyType.DG, wilayaCode: '16', status: CompanyStatus.ACTIF },
  { id: 'a-saa-setif', companyId: 'c-saa', code: 'AG-19-01', name: 'SAA Sétif', type: AgencyType.AG, parentId: 'a-saa-dg', wilayaCode: '19', status: CompanyStatus.ACTIF },
];
