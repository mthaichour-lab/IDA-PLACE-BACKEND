import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AdherentsService } from '../adherents/adherents.service';
import { normalizeCircumstances, normalizeReferenceCode, resolvePublishedBaremeCase } from '../adherents/bareme-rules';
import { paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { assertCompanyAccess, resolveTenantFilter } from '../common/rbac/tenant-scope';
import { EligibilityService } from '../eligibility/eligibility.service';
import { MatchingService } from '../matching/matching.service';
import { ClaimMatchInput } from '../matching/matching.types';
import { RealtimeGateway } from '../realtime/realtime.module';
import { CreateRecoursDto, RecoursViewDto } from '../recours/dto/recours.dto';
import { RecoursService } from '../recours/recours.service';
import { CLAIM_IMPORT_COLUMNS } from './claim-47-columns';
import { ClaimArt14Fields, resolveImportedArt14 } from './claim-art14';
import { CLAIM_IMPORT_COLUMNS_V2 } from './claim-extension-columns';
import { parseClaimFile } from './claim-parser';
import { Claim } from './entities/claim.entity';
import { ClaimImportReportDto, ClaimImportRowResultDto, ClaimImportWarningDto } from './dto/claim-import.dto';
import { ClaimViewDto, ListClaimsQueryDto, UpdateClaimResponsabiliteDto } from './dto/claim.dto';

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
    dateDemandeRecours: c.dateDemandeRecours,
    canalDeclaration: c.canalDeclaration,
    // Additif (2026-10-18) — lu depuis `raw` (colonne 44, jamais promue en
    // colonne typée : voir `ClaimViewDto.assureIdentite`, aucune migration).
    assureIdentite: c.raw.assureAIdentite as string | undefined,
    circonstancesA: c.circonstancesA ?? undefined,
    circonstancesB: c.circonstancesB ?? undefined,
    baremeVersionId: c.baremeVersionId ?? undefined,
    baremeCode: c.baremeCode ?? undefined,
    vehicleCategoryA: c.vehicleCategoryA ?? undefined,
    vehicleCategoryB: c.vehicleCategoryB ?? undefined,
    responsabiliteDeclareeA: c.responsabiliteDeclareeA ?? undefined,
    responsabiliteDeclareeB: c.responsabiliteDeclareeB ?? undefined,
  };
}

/** `null` (effacement) devient une absence de valeur, comme pour un dossier jamais renseigné. */
function art14View(f: ClaimArt14Fields): Partial<ClaimViewDto> {
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v ?? undefined])) as Partial<ClaimViewDto>;
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
    // Additif (2026-10-18, écran 2 "Vue de confrontation") — affichage
    // uniquement, voir ClaimMatchInput.
    assureIdentite: c.assureIdentite,
    canalDeclaration: c.canalDeclaration,
    responsabilite: {
      circonstancesA: c.circonstancesA,
      circonstancesB: c.circonstancesB,
      baremeVersionId: c.baremeVersionId,
      baremeCode: c.baremeCode,
      vehicleCategoryA: c.vehicleCategoryA,
      vehicleCategoryB: c.vehicleCategoryB,
      responsabiliteDeclareeA: c.responsabiliteDeclareeA,
      responsabiliteDeclareeB: c.responsabiliteDeclareeB,
    },
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
    private readonly recours: RecoursService,
    private readonly adherents: AdherentsService,
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

  /**
   * Ouverture d'un recours (Annexe 2) sur un dossier RÉEL : il doit exister,
   * appartenir à l'assureur direct (`from`), viser la partie tierce déclarée
   * (`to`), être éligible IDA (sinon « pas de recours conventionnel »,
   * Diagramme 1), et ne pas avoir déjà de recours — un second recours
   * conduirait à une double compensation. Vit ici et non dans RecoursModule :
   * ClaimsModule dépend déjà de RecoursModule, l'inverse créerait un cycle.
   */
  async openRecours(dto: CreateRecoursDto, user: AuthenticatedUser): Promise<RecoursViewDto> {
    assertCompanyAccess(user, dto.from);
    const claim = await this.get(dto.claimId, user);
    if (claim.company !== dto.from) {
      throw new BadRequestException({ code: 'RECOURS_HORS_ASSUREUR_DIRECT', message: `Le recours est présenté par l'assureur direct du dossier (${claim.company}), pas par ${dto.from}.` });
    }
    if (claim.counterpartyCompany && claim.counterpartyCompany !== dto.to) {
      throw new BadRequestException({ code: 'RECOURS_MAUVAISE_PARTIE', message: `Le dossier désigne ${claim.counterpartyCompany} comme partie tierce, pas ${dto.to}.` });
    }
    if (claim.eligibilityVerdict !== 'ELIGIBLE_IDA') {
      throw new BadRequestException({ code: 'DOSSIER_HORS_IDA', message: 'Dossier hors IDA : pas de recours conventionnel dans le cadre de la convention.' });
    }
    // SEC-06 : le recours ne peut pas réclamer plus que le dossier — montant
    // expertisé, à défaut estimé (le plafond conventionnel et le format du
    // montant sont contrôlés par RecoursService.create).
    const claimAmount = claim.expertAmount ?? claim.estimatedAmount;
    if (typeof claimAmount !== 'number' || !Number.isFinite(claimAmount) || claimAmount <= 0) {
      throw new BadRequestException({ code: 'MONTANT_DOSSIER_INCONNU', message: 'Le dossier ne porte aucun montant (expertisé ou estimé) : recours impossible.' });
    }
    if (dto.amount > claimAmount) {
      throw new BadRequestException({ code: 'RECOURS_MONTANT_SUPERIEUR_DOSSIER', message: `Le montant du recours dépasse celui du dossier (${claimAmount} DA).` });
    }
    // Audit sécurité 2026-10-19 : une compagnie qui n'est plus ACTIF ne peut
    // plus ouvrir de NOUVEAU recours — règle centralisée (voir aussi
    // MatchingService.decide, ClaimsService.importFile).
    await this.adherents.assertCompanyActiveFor(dto.from, claim.accidentDate);
    // Contrôle anticipé (message clair) ; l'unicité réelle, y compris sous
    // requêtes concurrentes, est garantie par RecoursService.create (SEC-20 :
    // contrainte UNIQUE(claim_id) en base, 409 RECOURS_EXISTANT).
    if ((await this.recours.listAll()).some((r) => r.claimId === claim.id)) {
      throw new ConflictException({ code: 'RECOURS_EXISTANT', message: 'Un recours existe déjà pour ce dossier.' });
    }
    return this.recours.create(dto, user);
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

  /** Modèle v2 : les 47 colonnes du v1 puis les colonnes 48-53 du barème Art. 14. */
  columnsV2() {
    return CLAIM_IMPORT_COLUMNS_V2;
  }

  private async persistClaim(
    values: Record<string, unknown>,
    verdict: 'ELIGIBLE_IDA' | 'HORS_IDA',
    reasons: string[],
    fileName: string,
    art14: ClaimArt14Fields,
    raw: Record<string, unknown>,
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
          ...art14,
          state,
          eligibilityVerdict: verdict,
          eligibilityReasons: reasons,
          raw,
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
          dateDemandeRecours: values.dateDemandeRecours as string | undefined,
          canalDeclaration: values.canalDeclaration as string | undefined,
          // Additif (2026-10-18) — même donnée que `toClaimView` (colonne 44),
          // ici lue directement sur `values` (pas de `raw` dans ce repli mémoire).
          assureIdentite: values.assureAIdentite as string | undefined,
          ...art14View(art14),
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
    const warnings: ClaimImportWarningDto[] = [];
    const needsReferential = parsedRows.some((r) => r.extension.baremeCode || r.extension.vehicleCategoryA || r.extension.vehicleCategoryB);
    const [publishedCases, publishedCategories] = needsReferential
      ? await Promise.all([this.adherents.publishedBaremeCases(), this.adherents.publishedVehicleCategories()])
      : [[], []];

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
      // Audit sécurité 2026-10-19 : une compagnie non ACTIF ne déclare plus
      // de nouveau dossier (même règle que ClaimsService.openRecours) — une
      // ligne rejetée reste HORS_IDA avec son motif, jamais un échec de tout
      // le fichier : c'est le contrat de ce rapport ligne par ligne.
      const companyCode = v.compagnieA as string | undefined;
      const inactiveReason = companyCode ? await this.adherents.companyInactiveReason(companyCode, v.dateAccident as string | undefined) : undefined;
      const verdict: 'ELIGIBLE_IDA' | 'HORS_IDA' = hasParseErrors || inactiveReason ? 'HORS_IDA' : eligibility.verdict;
      const reasons = [
        ...(hasParseErrors ? row.errors.map((e) => `Erreur de format : ${e}`) : []),
        ...(inactiveReason ? [inactiveReason] : []),
        ...eligibility.reasons,
      ];

      const art14 = resolveImportedArt14(v, row.extension, publishedCases, publishedCategories);
      warnings.push(...[...row.warnings, ...art14.warnings].map((w) => ({ rowNumber: row.rowNumber, ...w })));
      // `raw` garde la ligne source entière, y compris une valeur d'extension ignorée.
      const view = await this.persistClaim(v, verdict, reasons, fileName, art14.fields, { ...v, ...row.extension });
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
      warnings,
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

  /**
   * Saisie Art. 14 (décision PO §5). CORRESPONDANT_IDA : dossier de SA
   * compagnie et aucun recours ouvert. Ensuite, seuls les rôles `matchDecide`.
   * Un code ou une catégorie hors référentiel `VALIDE_UAR` est refusé (400).
   */
  async updateResponsabilite(id: string, dto: UpdateClaimResponsabiliteDto, user: AuthenticatedUser): Promise<ClaimViewDto> {
    const current = await this.get(id, user);
    const tenant = resolveTenantFilter(user);
    if (tenant) {
      if (!user.privileges.includes('insert')) {
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Privilège requis manquant (insert).' });
      }
      if (current.company !== tenant) {
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Seule la compagnie déclarante renseigne le barème Art. 14 de ce dossier.' });
      }
      // Contrôle d'intégrité, pas une lecture : il doit voir tous les recours du dossier, y compris hors périmètre de l'appelant.
      if ((await this.recours.listAll()).some((r) => r.claimId === id)) {
        throw new ForbiddenException({ code: 'RECOURS_OUVERT', message: 'Un recours est ouvert sur ce dossier : seul l’opérateur de la place peut encore modifier le barème Art. 14.' });
      }
    } else if (!user.privileges.includes('matchDecide')) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Privilège requis manquant (matchDecide).' });
    }

    const patch = await this.art14Patch(dto);
    const updated = await withDegradedFallback(
      'ClaimsService.updateResponsabilite',
      async () => {
        const c = await this.repo.findOneOrFail({ id });
        this.repo.assign(c, patch as never);
        await this.repo.getEntityManager().flush();
        return toClaimView(c);
      },
      () => {
        const c = MEMORY_CLAIMS.find((m) => m.id === id);
        if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Dossier introuvable (mode dégradé).' });
        Object.assign(c, art14View(patch));
        return c;
      },
    );
    await this.matching.refreshDeclaration(toMatchInput(updated));
    return updated;
  }

  private async art14Patch(dto: UpdateClaimResponsabiliteDto): Promise<ClaimArt14Fields> {
    const patch: ClaimArt14Fields = {};
    for (const key of ['circonstancesA', 'circonstancesB'] as const) {
      const value = dto[key];
      if (value !== undefined) patch[key] = value === null ? null : normalizeCircumstances(value);
    }
    if (dto.baremeCode === null) {
      patch.baremeCode = null;
      patch.baremeVersionId = null;
    } else if (dto.baremeCode !== undefined) {
      const found = resolvePublishedBaremeCase(await this.adherents.publishedBaremeCases(), dto.baremeCode, dto.baremeVersionId);
      if (!found) {
        const scope = dto.baremeVersionId ? ` dans la version « ${dto.baremeVersionId} »` : '';
        throw new BadRequestException({ code: 'BAREME_NON_PUBLIE', message: `Barème non publié : code « ${dto.baremeCode} » absent de toute version VALIDE_UAR${scope}.` });
      }
      patch.baremeCode = found.code;
      patch.baremeVersionId = found.versionId;
    } else if (dto.baremeVersionId !== undefined) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'baremeVersionId ne se renseigne qu’avec baremeCode.' });
    }
    const categoryKeys = (['vehicleCategoryA', 'vehicleCategoryB'] as const).filter((k) => dto[k] !== undefined);
    const published = categoryKeys.some((k) => dto[k] !== null) ? new Set((await this.adherents.publishedVehicleCategories()).map((c) => c.code)) : new Set<string>();
    for (const key of categoryKeys) {
      const raw = dto[key];
      if (raw === null || raw === undefined) {
        patch[key] = null;
        continue;
      }
      const code = normalizeReferenceCode(raw);
      if (!published.has(code)) {
        throw new BadRequestException({ code: 'BAREME_NON_PUBLIE', message: `Barème non publié : catégorie de véhicule « ${raw} » non validée UAR.` });
      }
      patch[key] = code;
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Aucun champ du barème Art. 14 à modifier.' });
    }
    return patch;
  }
}
