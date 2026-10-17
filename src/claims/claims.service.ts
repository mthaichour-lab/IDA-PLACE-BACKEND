import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { resolveTenantFilter } from '../common/rbac/tenant-scope';
import { EligibilityService } from '../eligibility/eligibility.service';
import { MatchingService } from '../matching/matching.service';
import { ClaimMatchInput } from '../matching/matching.types';
import { RealtimeGateway } from '../realtime/realtime.module';
import { CLAIM_IMPORT_COLUMNS } from './claim-47-columns';
import { parseClaimFile } from './claim-parser';
import { Claim } from './entities/claim.entity';
import { ClaimImportReportDto, ClaimImportRowResultDto } from './dto/claim-import.dto';
import { ClaimViewDto, ListClaimsQueryDto } from './dto/claim.dto';

/** Repli mémoire — mode dégradé. Persistant pour la durée du process (voir README "Mode dégradé"). */
const MEMORY_CLAIMS: ClaimViewDto[] = [];

function toClaimView(c: Claim): ClaimViewDto {
  return {
    id: c.id,
    numEconstat: c.numEconstat ?? '',
    company: c.company,
    counterpartyCompany: c.counterpartyCompany ?? '',
    accidentDate: c.accidentDate ?? '',
    wilaya: c.wilaya ?? '',
    estimatedAmount: c.estimatedAmount ?? 0,
    expertAmount: c.expertAmount,
    state: c.state,
    createdAt: c.createdAt.toISOString(),
    commune: c.commune,
    accidentTime: c.accidentTime,
    plateA: c.plateA,
    plateB: c.plateB,
    policeA: c.policeA,
    policeB: c.policeB,
    gpsLat: c.gpsLat,
    gpsLng: c.gpsLng,
    eligibilityVerdict: c.eligibilityVerdict,
    eligibilityReasons: c.eligibilityReasons,
  };
}

function toMatchInput(c: ClaimViewDto): ClaimMatchInput {
  return {
    id: c.id,
    numEconstat: c.numEconstat,
    company: c.company,
    counterpartyCompany: c.counterpartyCompany,
    plateA: c.plateA,
    plateB: c.plateB,
    policeA: c.policeA,
    policeB: c.policeB,
    accidentDate: c.accidentDate,
    accidentTime: c.accidentTime,
    wilaya: c.wilaya,
    commune: c.commune,
    gpsLat: c.gpsLat,
    gpsLng: c.gpsLng,
  };
}

/**
 * ClaimsModule — B.2 : ingestion ERP/e-constat/import, modèle 47 colonnes
 * (B.4). Parsing réel (`claim-parser.ts`, exceljs/CSV), verdict ligne à
 * ligne délégué à `EligibilityModule` (B.6), persistance réelle (`Claim`,
 * B.3), déclenchement du calcul d'appariement (`MatchingModule`, B.5) et
 * événement temps réel `claim.ingested` (B.12) après import.
 *
 * Contrat stable (voir HANDOFF.md) : la forme de `ClaimImportReportDto`,
 * `ClaimViewDto` et des routes `POST /claims/import`, `GET /claims`,
 * `GET /claims/:id` ne change pas.
 */
@Injectable()
export class ClaimsService {
  constructor(
    @InjectRepository(Claim) private readonly repo: EntityRepository<Claim>,
    private readonly eligibility: EligibilityService,
    private readonly matching: MatchingService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private async findAll(): Promise<ClaimViewDto[]> {
    return withDegradedFallback(
      'ClaimsService.findAll',
      async () => {
        const rows = await this.repo.findAll({ orderBy: { createdAt: 'DESC' }, limit: 5000 });
        return rows.map(toClaimView);
      },
      () => [...MEMORY_CLAIMS].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    );
  }

  /**
   * Scoping tenant (B.7, §5 de la mission) : un `CORRESPONDANT_IDA`/
   * `TRESORIER` ne voit que les dossiers où sa compagnie est émettrice
   * (`company`) OU partie adverse déclarée (`counterpartyCompany`) — il
   * est partie à l'échange dans les deux cas. Les rôles "place" (dont
   * `AUDITEUR_CSA`, lecture complète) ne sont pas filtrés. `user` optionnel
   * pour préserver les appelants internes (CockpitModule) qui agrègent
   * déjà sur l'ensemble des dossiers sans notion d'utilisateur courant.
   */
  private visibleToUser(c: ClaimViewDto, user?: AuthenticatedUser): boolean {
    if (!user) return true;
    const tenant = resolveTenantFilter(user);
    if (!tenant) return true;
    return c.company === tenant || c.counterpartyCompany === tenant;
  }

  async list(query: ListClaimsQueryDto, user?: AuthenticatedUser): Promise<PaginatedResult<ClaimViewDto>> {
    let rows = await this.findAll();
    rows = rows.filter((c) => this.visibleToUser(c, user));
    if (query.company) rows = rows.filter((c) => c.company === query.company);
    if (query.state) rows = rows.filter((c) => c.state === query.state);
    return paginateArray(rows, query.page, query.pageSize);
  }

  async get(id: string, user?: AuthenticatedUser): Promise<ClaimViewDto> {
    const view = await withDegradedFallback(
      'ClaimsService.get',
      async () => {
        const c = await this.repo.findOne({ id });
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Dossier introuvable.' });
        return toClaimView(c);
      },
      () => {
        const c = MEMORY_CLAIMS.find((m) => m.id === id);
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Dossier introuvable (mode dégradé).' });
        return c;
      },
    );
    if (!this.visibleToUser(view, user)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Accès hors périmètre de la compagnie.' });
    }
    return view;
  }

  columns() {
    return CLAIM_IMPORT_COLUMNS;
  }

  private async persistClaim(
    values: Record<string, unknown>,
    verdict: 'ELIGIBLE_IDA' | 'HORS_IDA',
    reasons: string[],
    fileName: string,
  ): Promise<ClaimViewDto> {
    // Pipeline des dossiers (B.3) : un dossier jugé HORS_IDA n'entre jamais
    // en file d'appariement ; un dossier ELIGIBLE_IDA passe en "A_APPARIER"
    // (écran 2 — MatchingModule prend le relais).
    const state = verdict === 'ELIGIBLE_IDA' ? 'A_APPARIER' : 'HORS_IDA';

    return withDegradedFallback(
      'ClaimsService.persistClaim',
      async () => {
        const entity = this.repo.create({
          numEconstat: values.numEconstat as string | undefined,
          company: (values.compagnieA as string) ?? 'INCONNU',
          counterpartyCompany: values.compagnieB as string | undefined,
          accidentDate: values.dateAccident as string | undefined,
          accidentTime: values.heureAccident as string | undefined,
          wilaya: values.wilaya as string | undefined,
          commune: values.commune as string | undefined,
          gpsLat: values.gpsLat as number | undefined,
          gpsLng: values.gpsLng as number | undefined,
          plateA: values.immatriculationA as string | undefined,
          plateB: values.immatriculationB as string | undefined,
          policeA: (values.numPoliceA as string) ?? (values.numAttestationA as string | undefined),
          policeB: (values.numPoliceB as string) ?? (values.numAttestationB as string | undefined),
          nombreVehicules: values.nombreVehicules as number | undefined,
          territoire: values.territoire as string | undefined,
          dommagesCorporelsDeclares: values.dommagesCorporelsDeclares as boolean | undefined,
          adversePartieAdherente: values.adversePartieAdherente as boolean | undefined,
          adversePartieActive: values.adversePartieActive as boolean | undefined,
          estimatedAmount: values.montantEstime as number | undefined,
          expertAmount: values.montantExpertise as number | undefined,
          exclusions: values.exclusions as string[] | undefined,
          piecesFournies: values.piecesFournies as string[] | undefined,
          constatAmiableSigneDeuxParties: values.constatAmiableSigneDeuxParties as boolean | undefined,
          dateDemandeRecours: values.dateDemandeRecours as string | undefined,
          canalDeclaration: values.canalDeclaration as string | undefined,
          state,
          eligibilityVerdict: verdict,
          eligibilityReasons: reasons,
          raw: values,
          sourceFile: fileName,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await this.repo.getEntityManager().persistAndFlush(entity);
        return toClaimView(entity);
      },
      () => {
        const view: ClaimViewDto = {
          id: randomUUID(),
          numEconstat: (values.numEconstat as string) ?? '',
          company: (values.compagnieA as string) ?? 'INCONNU',
          counterpartyCompany: (values.compagnieB as string) ?? '',
          accidentDate: (values.dateAccident as string) ?? '',
          wilaya: (values.wilaya as string) ?? '',
          estimatedAmount: (values.montantEstime as number) ?? 0,
          expertAmount: values.montantExpertise as number | undefined,
          state,
          createdAt: new Date().toISOString(),
          commune: values.commune as string | undefined,
          accidentTime: values.heureAccident as string | undefined,
          plateA: values.immatriculationA as string | undefined,
          plateB: values.immatriculationB as string | undefined,
          policeA: (values.numPoliceA as string) ?? (values.numAttestationA as string | undefined),
          policeB: (values.numPoliceB as string) ?? (values.numAttestationB as string | undefined),
          gpsLat: values.gpsLat as number | undefined,
          gpsLng: values.gpsLng as number | undefined,
          eligibilityVerdict: verdict,
          eligibilityReasons: reasons,
        };
        MEMORY_CLAIMS.push(view);
        return view;
      },
    );
  }

  /**
   * Parse réellement le fichier (47 colonnes, B.4), délègue le verdict
   * ligne à ligne à `EligibilityModule` (B.6), persiste chaque dossier
   * (B.3), déclenche le calcul d'appariement (B.5) et émet `claim.ingested`
   * (B.12). Conserve EXACTEMENT la forme de `ClaimImportReportDto`.
   */
  async importFile(fileName: string, buffer: Buffer): Promise<ClaimImportReportDto> {
    const parsedRows = await parseClaimFile(buffer, fileName);
    const rows: ClaimImportRowResultDto[] = [];
    const created: ClaimViewDto[] = [];

    for (const row of parsedRows) {
      const v = row.values;
      const eligibility = this.eligibility.evaluate({
        nombreVehicules: v.nombreVehicules as number | undefined,
        territoire: v.territoire as string | undefined,
        dommagesCorporelsDeclares: v.dommagesCorporelsDeclares as boolean | undefined,
        adversePartieAdherente: v.adversePartieAdherente as boolean | undefined,
        adversePartieActive: v.adversePartieActive as boolean | undefined,
        montantEstime: v.montantEstime as number | undefined,
        montantExpertise: v.montantExpertise as number | undefined,
        dateAccident: v.dateAccident as string | undefined,
        dateDemandeRecours: v.dateDemandeRecours as string | undefined,
        exclusions: v.exclusions as string[] | undefined,
        piecesFournies: v.piecesFournies as string[] | undefined,
        constatAmiableSigneDeuxParties: v.constatAmiableSigneDeuxParties as boolean | undefined,
      });

      // Une ligne dont le parsing a produit des erreurs de format sur des
      // champs déterminants ne peut pas être jugée éligible en toute
      // confiance : elle est marquée HORS_IDA, erreurs de format comprises
      // dans les motifs (le front n'affiche que `reasons`, pas de champ
      // `errors` séparé — contrat `ClaimImportRowResultDto` stable).
      const hasParseErrors = row.errors.length > 0;
      const verdict: 'ELIGIBLE_IDA' | 'HORS_IDA' = hasParseErrors ? 'HORS_IDA' : eligibility.verdict;
      const reasons = hasParseErrors
        ? [...row.errors.map((e) => `Erreur de format : ${e}`), ...eligibility.reasons]
        : eligibility.reasons;

      const view = await this.persistClaim(v, verdict, reasons, fileName);
      created.push(view);
      rows.push({ rowNumber: row.rowNumber, verdict, reasons, data: v });
    }

    // Appariement (B.5) — recalcule la file pour chaque dossier nouvellement
    // ingéré, contre l'ensemble des dossiers existants (ClaimsModule dépend
    // de MatchingModule, jamais l'inverse — voir matching.service.ts).
    if (created.length > 0) {
      const allClaims = await this.findAll();
      for (const claim of created) {
        await this.matching.ingestClaim(toMatchInput(claim), allClaims.map(toMatchInput));
      }
    }

    const eligibleCount = rows.filter((r) => r.verdict === 'ELIGIBLE_IDA').length;
    const report: ClaimImportReportDto = {
      fileName,
      importedAt: new Date().toISOString(),
      totalRows: rows.length,
      eligibleCount,
      ineligibleCount: rows.length - eligibleCount,
      rows,
    };

    // B.12 — événement temps réel après tout import réussi.
    this.realtime.emitEvent('claim.ingested', {
      fileName: report.fileName,
      totalRows: report.totalRows,
      eligibleCount: report.eligibleCount,
      ineligibleCount: report.ineligibleCount,
      importedAt: report.importedAt,
    });

    return report;
  }
}
