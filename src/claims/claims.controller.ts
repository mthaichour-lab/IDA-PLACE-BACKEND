import { BadRequestException, Controller, Get, Param, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { ClaimsService } from './claims.service';
import { ClaimImportReportDto } from './dto/claim-import.dto';
import { ListClaimsQueryDto } from './dto/claim.dto';

/**
 * ClaimsModule — écrans 2 (matching) et 3 (import). Contrat stable
 * (§B.4, B.11, voir ARCHITECTURE.md §1).
 */
@ApiTags('claims')
@ApiBearerAuth()
@Controller('claims')
@UseGuards(AuthGuard, PrivilegesGuard)
export class ClaimsController {
  constructor(private readonly service: ClaimsService) {}

  @Get('import/columns')
  @ApiOperation({ summary: "Modèle 47 colonnes (identification + éligibilité) — B.4" })
  columns() {
    return this.service.columns();
  }

  // Revue sécurité 2026-10-18 : taille/type jamais bornés auparavant
  // (DoS par fichier géant, type arbitraire accepté). Limite et extensions
  // CSV/Excel RAISONNABLES mais provisoires — à valider avec le métier (pas
  // de valeur officielle dans le dossier technique), voir QUESTIONS_UAR.md.
  @Post('import')
  @Privileges('import')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Import Excel/CSV (47 colonnes) → rapport d’éligibilité ligne à ligne (B.4)' })
  @ApiOkResponse({ type: ClaimImportReportDto })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 20 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        cb(null, /\.(csv|xlsx|xls)$/i.test(file.originalname));
      },
    }),
  )
  async importFile(@UploadedFile() file?: { originalname?: string; buffer?: Buffer; size?: number }): Promise<ClaimImportReportDto> {
    if (!file?.buffer) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Fichier manquant (champ "file", multipart/form-data).' });
    }
    return this.service.importFile(file.originalname ?? 'import.xlsx', file.buffer);
  }

  @Get()
  @ApiOperation({ summary: 'Liste paginée des dossiers (6/p), filtrable par compagnie/état — scopée par compagnie (B.7)' })
  list(@Query() q: ListClaimsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.list(q, user);
  }

  @Get(':id')
  @ApiOperation({ summary: "Détail d'un dossier — scopé par compagnie (B.7)" })
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.get(id, user);
  }
}
