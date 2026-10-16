import { Controller, Get, Inject, Injectable, Module, Param, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
import { STORAGE_PROVIDER } from './documents.tokens';
import { LocalFsStorageProvider } from './providers/local-fs.provider';
import { S3StorageProvider } from './providers/s3.provider';
import { StorageProvider } from './providers/storage-provider.interface';

/**
 * DocumentsModule — écrans 2, 3, 12, B.2/B.10.
 * TODO(backend-agent): voir §B.10 — brancher Paperless (ingestion OCR +
 * indexation plein texte) après upload S3, lier le document au dossier
 * (Claim), journaliser la traçabilité de consultation (RG-09).
 */
@Injectable()
class DocumentsService {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  async upload(file: { originalname: string; buffer: Buffer; mimetype: string }, tenant: string) {
    const key = `${tenant}/${Date.now()}-${file.originalname}`;
    const stored = await this.storage.put(key, file.buffer, file.mimetype);
    const url = await this.storage.getPresignedUrl(key);
    return { ...stored, mode: this.storage.mode, url };
  }

  async presign(key: string) {
    return { key, url: await this.storage.getPresignedUrl(key), mode: this.storage.mode };
  }
}

@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
@UseGuards(AuthGuard)
class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  @Post('upload')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload de pièce (constat, carte grise, devis...) — S3/MinIO ou repli local dev' })
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: { originalname: string; buffer: Buffer; mimetype: string }) {
    return this.service.upload(file, 'default-tenant');
  }

  @Get('presign/:key')
  @ApiOperation({ summary: 'URL pré-signée à durée courte pour un document' })
  presign(@Param('key') key: string) {
    return this.service.presign(key);
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
