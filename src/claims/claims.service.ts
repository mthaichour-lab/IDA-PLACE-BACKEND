import { Injectable } from '@nestjs/common';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { CLAIM_IMPORT_COLUMNS } from './claim-47-columns';
import { ClaimImportReportDto, ClaimImportRowResultDto } from './dto/claim-import.dto';
import { ClaimViewDto, ListClaimsQueryDto } from './dto/claim.dto';

const MOCK_CLAIMS: ClaimViewDto[] = Array.from({ length: 14 }).map((_, i) => ({
  id: `clm-${1000 + i}`,
  numEconstat: `ECT-2026-${(10000 + i).toString()}`,
  company: ['CAAT', 'SAA', 'CASH', 'ALLI'][i % 4],
  counterpartyCompany: ['SAA', 'CASH', 'ALLI', 'CAAT'][i % 4],
  accidentDate: new Date(Date.UTC(2026, 0, (i % 27) + 1)).toISOString(),
  wilaya: ['16', '31', '25', '09', '19'][i % 5],
  estimatedAmount: 45000 + i * 7350,
  expertAmount: i % 3 === 0 ? 42000 + i * 6000 : undefined,
  state: ['RECU', 'A_APPARIER', 'APPARIE', 'ELIGIBLE', 'EN_RECOURS'][i % 5],
  createdAt: new Date(Date.UTC(2026, 0, (i % 27) + 1, 8 + i)).toISOString(),
}));

/**
 * ClaimsModule — B.2 : ingestion ERP/e-constat/import, modèle 47 colonnes.
 *
 * TODO(backend-agent): implémenter la logique métier réelle, voir §B.4 et
 * §B.6 du dossier technique :
 *  - parsing réel du fichier Excel/CSV (47 colonnes, §B.4) avec une
 *    librairie de parsing (ex: `exceljs`) au lieu du générateur de mock
 *    `buildMockImportReport` ci-dessous ;
 *  - délégation du verdict ligne à ligne à `EligibilityModule` (règles
 *    Art. 3/4/5-6/13/19/28, §B.6) plutôt que le tirage pseudo-aléatoire
 *    actuel ;
 *  - persistance réelle des `Claim`/`Declaration` (entité MikroORM +
 *    migration, §B.3) à la place du tableau `MOCK_CLAIMS` ;
 *  - émission de l'événement temps réel `claim.ingested` (RealtimeModule,
 *    §B.12) après import.
 * NE PAS changer la forme du DTO `ClaimImportReportDto` ni des routes.
 */
@Injectable()
export class ClaimsService {
  list(query: ListClaimsQueryDto): PaginatedResult<ClaimViewDto> {
    let rows = MOCK_CLAIMS;
    if (query.company) rows = rows.filter((c) => c.company === query.company);
    if (query.state) rows = rows.filter((c) => c.state === query.state);
    return paginateArray(rows, query.page, query.pageSize);
  }

  get(id: string): ClaimViewDto | undefined {
    return MOCK_CLAIMS.find((c) => c.id === id);
  }

  columns() {
    return CLAIM_IMPORT_COLUMNS;
  }

  /** Génère un rapport d'import plausible (mock) à la forme finale exacte du contrat B.4/B.11. */
  buildMockImportReport(fileName: string, rowCount = 8): ClaimImportReportDto {
    const rows: ClaimImportRowResultDto[] = Array.from({ length: rowCount }).map((_, i) => {
      const eligible = i % 4 !== 0;
      const reasons = eligible
        ? []
        : [
            ['Montant estimé (45 2000 DA) > plafond 300 000 DA — Art. 4', 'Exclusion contractuelle déclarée — Art. 5-6', 'Pièce obligatoire manquante — Art. 13'][i % 3],
          ];
      const sample: Record<string, unknown> = {};
      for (const col of CLAIM_IMPORT_COLUMNS) {
        sample[col.key] = mockValueFor(col.key, i);
      }
      return {
        rowNumber: i + 1,
        verdict: eligible ? 'ELIGIBLE_IDA' : 'HORS_IDA',
        reasons,
        data: sample,
      };
    });

    const eligibleCount = rows.filter((r) => r.verdict === 'ELIGIBLE_IDA').length;
    return {
      fileName,
      importedAt: new Date().toISOString(),
      totalRows: rows.length,
      eligibleCount,
      ineligibleCount: rows.length - eligibleCount,
      rows,
    };
  }
}

function mockValueFor(key: string, i: number): unknown {
  const companies = ['CAAT', 'SAA', 'CASH', 'ALLI'];
  switch (key) {
    case 'numEconstat':
      return `ECT-2026-${20000 + i}`;
    case 'dateDeclaration':
    case 'dateDemandeRecours':
    case 'dateAccident':
    case 'validiteADebut':
    case 'validiteAFin':
    case 'validiteBDebut':
    case 'validiteBFin':
    case 'dateExpertise':
      return new Date(Date.UTC(2026, 0, (i % 27) + 1)).toISOString().slice(0, 10);
    case 'nombreVehicules':
      return 2;
    case 'territoire':
      return 'ALGERIE';
    case 'wilaya':
      return ['16', '31', '25', '09'][i % 4];
    case 'compagnieA':
      return companies[i % 4];
    case 'compagnieB':
      return companies[(i + 1) % 4];
    case 'montantEstime':
    case 'montantExpertise':
      return 40000 + i * 5000;
    case 'exclusions':
    case 'piecesFournies':
      return [];
    case 'constatAmiableSigneDeuxParties':
    case 'conducteurAEstAssure':
    case 'conducteurBEstAssure':
    case 'adversePartieAdherente':
    case 'adversePartieActive':
      return i % 4 !== 0;
    case 'responsabiliteDeclareeA':
      return 60;
    case 'responsabiliteDeclareeB':
      return 40;
    case 'canalDeclaration':
      return 'IMPORT';
    default:
      return null;
  }
}
