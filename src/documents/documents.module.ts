import { basename } from 'path';
import { BadRequestException, Body, Controller, Get, Inject, Injectable, Module, Param, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { InjectRepository, MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { assertCompanyAccess, resolveTenantFilter } from '../common/rbac/tenant-scope';
import { CommissionModule } from '../commission/commission.module';
import { CommissionService } from '../commission/commission.service';
import { RecoursModule } from '../recours/recours.module';
import { RecoursService } from '../recours/recours.service';
import { DocumentViewDto, ListDocumentsQueryDto, UploadDocumentDto } from './dto/document.dto';
import { Document } from './entities/document.entity';
import { STORAGE_PROVIDER } from './documents.tokens';
import { LocalFsStorageProvider } from './providers/local-fs.provider';
import { S3StorageProvider } from './providers/s3.provider';
import { StorageProvider } from './providers/storage-provider.interface';

/**
 * Préfixe de clé pour les documents uploadés par un rôle "place" (pas de
 * compagnie à qui rattacher le fichier). Décision volontaire (revue
 * sécurité 2026-10-18, B.7/B.10) : un document "place" est visible par
 * tout utilisateur authentifié (aucune compagnie n'en est propriétaire) ;
 * un document uploadé par un rôle scopé compagnie est préfixé par SA
 * compagnie et seule cette compagnie (+ les rôles place) peut en obtenir
 * une URL pré-signée.
 */
const PLACE_PREFIX = 'place';

/**
 * Revue sécurité 2026-10-18 : `file.originalname` (multipart, entièrement
 * contrôlé par l'appelant) ne doit JAMAIS entrer tel quel dans une clé de
 * stockage utilisée comme segment de chemin disque
 * (`LocalFsStorageProvider.put`, `join(baseDir, key)`) — un nom comme
 * `"../../../../etc/cron.d/x"` traverse hors de `baseDir` (`path.join` NE
 * clampe PAS au répertoire de base, il normalise seulement les `..`).
 * `basename()` élimine tout composant de répertoire, puis seuls
 * alphanumérique/`.`/`-`/`_` sont conservés (remplacement par `_` sinon) —
 * défense en profondeur, voir aussi le contrôle de confinement dans
 * `LocalFsStorageProvider.put`.
 */
function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9.\-_]/g, '_');
  return base.length > 0 ? base : 'fichier';
}

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
  };
}

/**
 * DocumentsModule — écrans 2, 3, 12, B.2/B.10. Depuis QUESTIONS_UAR.md §9
 * (décision Product Owner 2026-10-18), étend aussi l'attachement d'une
 * pièce à un `Recours` (RecoursModule) ou un `CommissionCase`
 * (CommissionModule) — dépôt MANUEL par l'utilisateur, jamais de
 * génération automatique de PDF (voir la question posée et sa réponse).
 * `Document` (`entities/document.entity.ts`) est le premier enregistrement
 * PERSISTÉ de ce module — avant, `upload()` écrivait les octets sans rien
 * enregistrer en base.
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
  ) {}

  /**
   * §9 : au plus un de `recoursId`/`commissionCaseId` — validé en service,
   * pas en base (voir `document.entity.ts`). Quand l'un des deux est fourni,
   * on réutilise le contrôle d'existence + de périmètre compagnie DÉJÀ
   * existant de `RecoursService.get`/`CommissionService.getCase` (même
   * pattern que `CommissionService.createCase` — "réutiliser le contrôle de
   * l'appelé en lui transmettant réellement `user`", voir HANDOFF.md section
   * sécurité 2026-10-18) : un 404 (dossier introuvable) ou 403 (hors
   * périmètre compagnie) remonte ici tel quel, AVANT d'écrire le moindre
   * octet sur le stockage.
   */
  private async assertAttachmentTarget(recoursId: string | undefined, commissionCaseId: string | undefined, user: AuthenticatedUser): Promise<void> {
    if (recoursId && commissionCaseId) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: 'Un document ne peut être attaché qu’à un seul dossier (recoursId OU commissionCaseId, jamais les deux).',
      });
    }
    if (recoursId) await this.recours.get(recoursId, user);
    if (commissionCaseId) await this.commission.getCase(commissionCaseId, user);
  }

  async upload(
    file: { originalname: string; buffer: Buffer; mimetype: string },
    user: AuthenticatedUser,
    recoursId?: string,
    commissionCaseId?: string,
  ) {
    await this.assertAttachmentTarget(recoursId, commissionCaseId, user);

    const tenant = resolveTenantFilter(user) ?? PLACE_PREFIX;
    const filename = sanitizeFilename(file.originalname);
    const key = `${tenant}/${Date.now()}-${filename}`;
    const stored = await this.storage.put(key, file.buffer, file.mimetype);
    const url = await this.storage.getPresignedUrl(key);

    // Comportement historique PRÉSERVÉ à l'identique : si ni recoursId ni
    // commissionCaseId n'est fourni, le document reste "non attaché" —
    // seule différence avec avant §9, un enregistrement `Document` est
    // désormais aussi persisté (voir en-tête de module).
    await this.persistDocument({ key: stored.key, filename, contentType: stored.contentType, sizeBytes: stored.sizeBytes, uploadedBy: user.name, recoursId, commissionCaseId });

    return { ...stored, mode: this.storage.mode, url };
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

  /**
   * §9 — `GET /documents?recoursId=X|commissionCaseId=Y` : liste les pièces
   * attachées à UN dossier précis. Même contrôle d'accès que `upload()`
   * (voir `assertAttachmentTarget`) : un 404/403 du dossier cible propage
   * tel quel, jamais avalé par le repli mémoire de `withDegradedFallback`
   * (même raison que `RecoursService.loadForTransition` : ne jamais
   * confondre une exception MÉTIER avec une bascule en mode dégradé).
   */
  async listForDossier(query: { recoursId?: string; commissionCaseId?: string }, user: AuthenticatedUser): Promise<DocumentViewDto[]> {
    const { recoursId, commissionCaseId } = query;
    if ((recoursId && commissionCaseId) || (!recoursId && !commissionCaseId)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Fournir exactement un des deux paramètres : recoursId OU commissionCaseId.' });
    }
    if (recoursId) await this.recours.get(recoursId, user);
    if (commissionCaseId) await this.commission.getCase(commissionCaseId, user);

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

    return Promise.all(
      rows.map(async (d): Promise<DocumentViewDto> => ({
        id: d.id,
        filename: d.filename,
        contentType: d.contentType,
        sizeBytes: d.sizeBytes,
        uploadedBy: d.uploadedBy,
        uploadedAt: d.uploadedAt,
        url: await this.storage.getPresignedUrl(d.key),
      })),
    );
  }

  /** Revue sécurité 2026-10-18 : refuse de signer une clé hors du préfixe compagnie de l'appelant (B.7) — le préfixe "place" reste ouvert à tous (aucune compagnie propriétaire). */
  async presign(key: string, user: AuthenticatedUser) {
    const tenant = key.split('/')[0];
    if (tenant !== PLACE_PREFIX) assertCompanyAccess(user, tenant);
    return { key, url: await this.storage.getPresignedUrl(key), mode: this.storage.mode };
  }
}

@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
@UseGuards(AuthGuard, PrivilegesGuard)
class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  // Revue sécurité 2026-10-18 : taille/type jamais bornés auparavant (DoS
  // par fichier géant, type arbitraire stocké puis re-servi). Limite et
  // types PDF/image RAISONNABLES mais provisoires — à valider avec le
  // métier (pas de valeur officielle dans le dossier technique pour les
  // pièces jointes B.10), voir QUESTIONS_UAR.md.
  @Post('upload')
  @Privileges('insert')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: "Upload de pièce (constat, carte grise, devis...) — S3/MinIO ou repli local dev. Clé préfixée par la compagnie de l'uploadeur (B.7), ou \"place\" pour les rôles place." })
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
      'QUESTIONS_UAR.md §9 — pièces attachées à un dossier (recoursId OU commissionCaseId, exactement un des deux) : 404 si le dossier n’existe pas, 403 si hors périmètre compagnie de l’appelant (même garde que RecoursService.get/CommissionService.getCase).',
  })
  listForDossier(@Query() query: ListDocumentsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listForDossier(query, user);
  }

  @Get('presign/:key')
  @ApiOperation({ summary: "URL pré-signée à durée courte pour un document — 403 si le préfixe compagnie de la clé ne correspond pas à celle de l'appelant (B.7)" })
  presign(@Param('key') key: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.presign(key, user);
  }
}

@Module({
  imports: [MikroOrmModule.forFeature([Document]), RecoursModule, CommissionModule],
  controllers: [DocumentsController],
  providers: [
    LocalFsStorageProvider,
    S3StorageProvider,
    {
      provide: STORAGE_PROVIDER,
      inject: [LocalFsStorageProvider, S3StorageProvider],
      useFactory: (local: LocalFsStorageProvider, s3: S3StorageProvider): StorageProvider =>
        process.env.S3_ENABLED === 'true' ? s3 : local,
    },
    DocumentsService,
  ],
  exports: [STORAGE_PROVIDER],
})
export class DocumentsModule {}
