import { basename } from 'path';
import { BadRequestException, Controller, Get, Inject, Injectable, Module, Param, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { assertCompanyAccess, resolveTenantFilter } from '../common/rbac/tenant-scope';
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

/**
 * DocumentsModule — écrans 2, 3, 12, B.2/B.10.
 * TODO(backend-agent): voir §B.10 — brancher Paperless (ingestion OCR +
 * indexation plein texte) après upload S3, lier le document au dossier
 * (Claim), journaliser la traçabilité de consultation (RG-09).
 */
@Injectable()
class DocumentsService {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  async upload(file: { originalname: string; buffer: Buffer; mimetype: string }, user: AuthenticatedUser) {
    const tenant = resolveTenantFilter(user) ?? PLACE_PREFIX;
    const key = `${tenant}/${Date.now()}-${sanitizeFilename(file.originalname)}`;
    const stored = await this.storage.put(key, file.buffer, file.mimetype);
    const url = await this.storage.getPresignedUrl(key);
    return { ...stored, mode: this.storage.mode, url };
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
  upload(@UploadedFile() file: { originalname: string; buffer: Buffer; mimetype: string } | undefined, @CurrentUser() user: AuthenticatedUser) {
    if (!file) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Fichier manquant ou type/taille non autorisé (PDF/JPEG/PNG/WEBP, 15 Mo max).' });
    }
    return this.service.upload(file, user);
  }

  @Get('presign/:key')
  @ApiOperation({ summary: "URL pré-signée à durée courte pour un document — 403 si le préfixe compagnie de la clé ne correspond pas à celle de l'appelant (B.7)" })
  presign(@Param('key') key: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.presign(key, user);
  }
}

@Module({
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
