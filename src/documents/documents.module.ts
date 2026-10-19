import { BadRequestException, Body, Controller, Get, Header, Inject, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { InjectRepository, MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { resolveTenantFilter } from '../common/rbac/tenant-scope';
import { CommissionModule } from '../commission/commission.module';
import { CommissionService } from '../commission/commission.service';
import { RecoursModule } from '../recours/recours.module';
import { RecoursService } from '../recours/recours.service';
import { ANTIVIRUS_SCANNER, AntivirusFactory, AntivirusScanner } from './antivirus';
import { assertDocumentContent, safeOriginalFilename } from './content-validation';
import { DocumentViewDto, ListDocumentsQueryDto, UploadDocumentDto } from './dto/document.dto';
import { Document } from './entities/document.entity';
import { StrictQuery } from '../claims/dto/strict-query.pipe';
import { STORAGE_PROVIDER } from './documents.tokens';
import { LocalFsStorageProvider } from './providers/local-fs.provider';
import { S3StorageProvider } from './providers/s3.provider';
import { StorageProvider } from './providers/storage-provider.interface';
import { attachmentDisposition, resolveDocumentStorageConfig } from './storage-config';

/** Préfixe de rangement des pièces déposées par un rôle place (aucune compagnie propriétaire). */
const PLACE_PREFIX = 'place';

const API_PREFIX = process.env.API_PREFIX ?? 'api/v1';

/** Repli mémoire — mode dégradé (voir `withDegradedFallback`). Une ligne = un `Document` (dates en ISO, comme partout ailleurs dans ce code base). */
type MemoryDocumentRow = {
  id: string;
  key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
  recoursId?: string;
  commissionCaseId?: string;
  ownerCompany?: string;
};

function toMemoryRow(e: Document): MemoryDocumentRow {
  return {
    id: e.id,
    key: e.key,
    filename: e.filename,
    contentType: e.contentType,
    sizeBytes: e.sizeBytes,
    uploadedBy: e.uploadedBy,
    uploadedAt: e.uploadedAt.toISOString(),
    recoursId: e.recoursId,
    commissionCaseId: e.commissionCaseId,
    ownerCompany: e.ownerCompany,
  };
}

const NOT_FOUND = () => new NotFoundException({ code: 'NOT_FOUND', message: 'Document introuvable.' });

/**
 * DocumentsModule — écrans 2, 3, 12, B.2/B.10. Depuis QUESTIONS_UAR.md §9
 * (décision Product Owner 2026-10-18), étend aussi l'attachement d'une
 * pièce à un `Recours` (RecoursModule) ou un `CommissionCase`
 * (CommissionModule) — dépôt MANUEL par l'utilisateur.
 *
 * Remédiation 2026-10-19 :
 *  - SEC-10 : clés de stockage ALÉATOIRES (`<compagnie|place>/<uuid>`, sans
 *    le nom d'origine) ; plus aucune route ne signe une clé passée en
 *    paramètre (`GET /documents/presign/:key` supprimée) ; téléchargement
 *    par IDENTIFIANT de document en base, après contrôle d'accès (dossier
 *    rattaché visible, ou compagnie propriétaire) — 404 sinon, sans révéler
 *    l'existence de la pièce.
 *  - SEC-11 : stockage objet obligatoire en production, SSE demandé à S3,
 *    téléchargement en pièce jointe avec `nosniff` (voir storage-config.ts).
 *  - SEC-29 : type réel vérifié par la signature des octets, analyse
 *    antivirus branchable (antivirus.ts).
 *
 * TODO(backend-agent): voir §B.10 — brancher Paperless (ingestion OCR +
 * indexation plein texte) après upload S3, journaliser la traçabilité de
 * consultation (RG-09).
 */
@Injectable()
export class DocumentsService {
  /** Repli mémoire — mode dégradé. Persistant pour la durée du process (voir README "Mode dégradé"). */
  private readonly memory: MemoryDocumentRow[] = [];

  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @InjectRepository(Document) private readonly repo: EntityRepository<Document>,
    private readonly recours: RecoursService,
    private readonly commission: CommissionService,
    @Inject(ANTIVIRUS_SCANNER) private readonly antivirus: AntivirusScanner,
  ) {}

  /**
   * §9 : au plus un de `recoursId`/`commissionCaseId`. Quand l'un des deux
   * est fourni, on réutilise le contrôle d'existence + de périmètre
   * compagnie de `RecoursService.get`/`CommissionService.getCase` : un 404
   * ou 403 remonte tel quel, AVANT d'écrire le moindre octet.
   */
  private async assertAttachmentTarget(recoursId: string | undefined, commissionCaseId: string | undefined, user: AuthenticatedUser): Promise<void> {
    if (recoursId && commissionCaseId) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: 'Un document ne peut être attaché qu’à un seul dossier (recoursId OU commissionCaseId, jamais les deux).',
      });
    }
    if (recoursId) await this.recours.getForUser(recoursId, user);
    if (commissionCaseId) await this.commission.getCaseForUser(commissionCaseId, user);
  }

  async upload(
    file: { originalname: string; buffer: Buffer; mimetype: string },
    user: AuthenticatedUser,
    recoursId?: string,
    commissionCaseId?: string,
  ) {
    await this.assertAttachmentTarget(recoursId, commissionCaseId, user);

    // SEC-10/SEC-29 : nom vérifié, type RÉEL vérifié, antivirus — avant toute écriture.
    const filename = safeOriginalFilename(file.originalname);
    const contentType = assertDocumentContent(file.buffer, file.mimetype);
    const verdict = await this.antivirus.scan(file.buffer);
    if (!verdict.clean) {
      throw new BadRequestException({ code: 'FICHIER_INFECTE', message: 'Fichier refusé par l’analyse antivirus.' });
    }

    const tenant = resolveTenantFilter(user);
    const key = `${tenant ?? PLACE_PREFIX}/${randomUUID()}`;
    const stored = await this.storage.put(key, file.buffer, contentType);
    const row = await this.persistDocument({
      key: stored.key,
      filename,
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
      uploadedBy: user.name,
      recoursId,
      commissionCaseId,
      ownerCompany: tenant,
    });

    return { id: row.id, filename, contentType: stored.contentType, sizeBytes: stored.sizeBytes, mode: this.storage.mode, url: await this.downloadUrl(row) };
  }

  private async persistDocument(record: Omit<MemoryDocumentRow, 'id' | 'uploadedAt'>): Promise<MemoryDocumentRow> {
    return withDegradedFallback(
      'DocumentsService.persistDocument',
      async () => {
        const entity = this.repo.create({
          key: record.key,
          filename: record.filename,
          contentType: record.contentType,
          sizeBytes: record.sizeBytes,
          uploadedBy: record.uploadedBy,
          recoursId: record.recoursId,
          commissionCaseId: record.commissionCaseId,
          ownerCompany: record.ownerCompany,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await this.repo.getEntityManager().persistAndFlush(entity);
        return toMemoryRow(entity);
      },
      () => {
        const row: MemoryDocumentRow = { id: randomUUID(), uploadedAt: new Date().toISOString(), ...record };
        this.memory.push(row);
        return row;
      },
    );
  }

  /** URL de téléchargement : pré-signée S3 (pièce jointe, type imposé) ou route API authentifiée en mode local. */
  private async downloadUrl(row: MemoryDocumentRow): Promise<string> {
    if (this.storage.presignedDownloadUrl) {
      return this.storage.presignedDownloadUrl(row.key, { filename: row.filename, contentType: row.contentType });
    }
    return `/${API_PREFIX}/documents/${row.id}/download`;
  }

  private toView(row: MemoryDocumentRow, url: string): DocumentViewDto {
    return { id: row.id, filename: row.filename, contentType: row.contentType, sizeBytes: row.sizeBytes, uploadedBy: row.uploadedBy, uploadedAt: row.uploadedAt, url };
  }

  /**
   * §9 — `GET /documents?recoursId=X|commissionCaseId=Y` : liste les pièces
   * attachées à UN dossier précis. Même contrôle d'accès que `upload()`.
   */
  async listForDossier(query: { recoursId?: string; commissionCaseId?: string }, user: AuthenticatedUser): Promise<DocumentViewDto[]> {
    const { recoursId, commissionCaseId } = query;
    if ((recoursId && commissionCaseId) || (!recoursId && !commissionCaseId)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Fournir exactement un des deux paramètres : recoursId OU commissionCaseId.' });
    }
    if (recoursId) await this.recours.getForUser(recoursId, user);
    if (commissionCaseId) await this.commission.getCaseForUser(commissionCaseId, user);

    const rows = await withDegradedFallback(
      'DocumentsService.listForDossier',
      async () => {
        const where = recoursId ? { recoursId } : { commissionCaseId };
        const entities = await this.repo.find(where, { orderBy: { uploadedAt: 'DESC' } });
        return entities.map(toMemoryRow);
      },
      () =>
        this.memory
          .filter((d) => (recoursId ? d.recoursId === recoursId : d.commissionCaseId === commissionCaseId))
          .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1)),
    );

    return Promise.all(rows.map(async (d) => this.toView(d, await this.downloadUrl(d))));
  }

  private async findById(id: string): Promise<MemoryDocumentRow | undefined> {
    return withDegradedFallback(
      'DocumentsService.findById',
      async () => {
        const e = await this.repo.findOne({ id });
        return e ? toMemoryRow(e) : undefined;
      },
      () => this.memory.find((d) => d.id === id),
    );
  }

  /**
   * SEC-10 — document lisible par `user` ? Rattaché à un dossier : mêmes
   * règles que ce dossier (parties du recours / du dossier de commission,
   * rôles place). Non rattaché : compagnie propriétaire ou rôles place ; un
   * document déposé par un rôle place reste lisible par tout utilisateur
   * authentifié (décision 2026-10-18 conservée). Toute absence de droit est
   * un 404 : l'existence de la pièce n'est pas révélée.
   */
  private async loadVisible(id: string, user: AuthenticatedUser): Promise<MemoryDocumentRow> {
    const row = await this.findById(id);
    if (!row) throw NOT_FOUND();
    try {
      if (row.recoursId) await this.recours.getForUser(row.recoursId, user);
      else if (row.commissionCaseId) await this.commission.getCaseForUser(row.commissionCaseId, user);
      else {
        const tenant = resolveTenantFilter(user);
        if (tenant && row.ownerCompany && row.ownerCompany !== tenant) throw NOT_FOUND();
      }
    } catch {
      throw NOT_FOUND();
    }
    return row;
  }

  async describe(id: string, user: AuthenticatedUser): Promise<DocumentViewDto> {
    const row = await this.loadVisible(id, user);
    return this.toView(row, await this.downloadUrl(row));
  }

  async download(id: string, user: AuthenticatedUser): Promise<{ content: Buffer; filename: string; contentType: string }> {
    const row = await this.loadVisible(id, user);
    return { content: await this.storage.get(row.key), filename: row.filename, contentType: row.contentType };
  }
}

@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
@UseGuards(AuthGuard, PrivilegesGuard)
class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  // Taille/types RAISONNABLES mais provisoires — à valider avec le métier
  // (voir QUESTIONS_UAR.md). Le filtre ci-dessous ne lit que le type DÉCLARÉ :
  // le type réel est vérifié sur les octets par le service (SEC-29).
  @Post('upload')
  @Privileges('insert')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload de pièce (constat, carte grise, devis...) — PDF/JPEG/PNG/WEBP réels (signature des octets), antivirus si activé ; renvoie l’id du document et son URL de téléchargement.' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 15 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        cb(null, /^(application\/pdf|image\/(jpeg|png|webp))$/.test(file.mimetype));
      },
    }),
  )
  upload(
    @UploadedFile() file: { originalname: string; buffer: Buffer; mimetype: string } | undefined,
    @Body() dto: UploadDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!file) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Fichier manquant ou type/taille non autorisé (PDF/JPEG/PNG/WEBP, 15 Mo max).' });
    }
    return this.service.upload(file, user, dto.recoursId, dto.commissionCaseId);
  }

  @Get()
  @Privileges('insert')
  @ApiOperation({
    summary:
      'QUESTIONS_UAR.md §9 — pièces attachées à un dossier (recoursId OU commissionCaseId, exactement un des deux) : 404 si le dossier n’existe pas, 403 si hors périmètre compagnie de l’appelant.',
  })
  @StrictQuery(ListDocumentsQueryDto)
  listForDossier(@Query() query: ListDocumentsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listForDossier(query, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'SEC-10 — métadonnées et URL de téléchargement d’un document, par identifiant (404 si hors périmètre)' })
  describe(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.describe(id, user);
  }

  @Get(':id/download')
  @ApiProduces('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'SEC-10/11 — téléchargement d’un document par identifiant après contrôle d’accès (404 si hors périmètre), en pièce jointe' })
  async download(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<StreamableFile> {
    const { content, filename, contentType } = await this.service.download(id, user);
    return new StreamableFile(content, { type: contentType, disposition: attachmentDisposition(filename), length: content.length });
  }
}

@Module({
  imports: [MikroOrmModule.forFeature([Document]), RecoursModule, CommissionModule],
  controllers: [DocumentsController],
  providers: [
    LocalFsStorageProvider,
    S3StorageProvider,
    AntivirusFactory,
    {
      provide: STORAGE_PROVIDER,
      inject: [LocalFsStorageProvider, S3StorageProvider],
      // SEC-11 : `resolveDocumentStorageConfig` refuse le démarrage en production sans stockage objet.
      useFactory: (local: LocalFsStorageProvider, s3: S3StorageProvider): StorageProvider => (resolveDocumentStorageConfig().useS3 ? s3 : local),
    },
    { provide: ANTIVIRUS_SCANNER, inject: [AntivirusFactory], useFactory: (f: AntivirusFactory) => f.create() },
    DocumentsService,
  ],
  exports: [STORAGE_PROVIDER],
})
export class DocumentsModule {}
