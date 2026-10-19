import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { StrictQuery } from './dto/strict-query.pipe';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { ClaimsService } from './claims.service';
import { ClaimImportReportDto, ImportClaimsQueryDto } from './dto/claim-import.dto';
import { ListClaimsQueryDto, UpdateClaimResponsabiliteDto } from './dto/claim.dto';

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

  @Get('import/columns/v2')
  @ApiOperation({ summary: 'Modèle v2 : les 47 colonnes du v1 puis les colonnes 48-53 du barème Art. 14 (décision PO §5)' })
  columnsV2() {
    return this.service.columnsV2();
  }

  // Revue sécurité 2026-10-18 : taille/type jamais bornés auparavant
  // (DoS par fichier géant, type arbitraire accepté). Limite et extensions
  // CSV/Excel RAISONNABLES mais provisoires — à valider avec le métier (pas
  // de valeur officielle dans le dossier technique), voir QUESTIONS_UAR.md.
  // SEC-12 : `.xls` passe ce filtre pour recevoir un 400 explicite ; le
  // contenu réel (signature, archive, nombre de lignes) est vérifié par
  // `import-file-guard.ts` avant tout parsing.
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
  @StrictQuery(ImportClaimsQueryDto)
  async importFile(
    @Query() q: ImportClaimsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file?: { originalname?: string; buffer?: Buffer; size?: number },
  ): Promise<ClaimImportReportDto> {
    if (!file?.buffer) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Fichier manquant (champ "file", multipart/form-data).' });
    }
    // SEC-02 : la compagnie déclarante vient de l'utilisateur (ou du paramètre explicite d'un rôle place), jamais du fichier.
    return this.service.importFile(file.originalname ?? 'import.xlsx', file.buffer, user, q.company);
  }

  @Get()
  @ApiOperation({ summary: 'Liste paginée des dossiers (6/p), filtrable par compagnie/état — scopée par compagnie (B.7)' })
  @StrictQuery(ListClaimsQueryDto)
  list(@Query() q: ListClaimsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.list(q, user);
  }

  @Get(':id')
  @ApiOperation({ summary: "Détail d'un dossier — scopé par compagnie (B.7)" })
  get(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.get(id, user);
  }

  @Patch(':id/responsabilite')
  @Privileges('insert', 'matchDecide')
  @ApiOperation({
    summary:
      'Barème Art. 14 du dossier : circonstances (1-17), code de barème et catégories (VALIDE_UAR, sinon 400). CORRESPONDANT_IDA (insert) : sa compagnie, avant tout recours ; ensuite, rôles matchDecide',
  })
  updateResponsabilite(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateClaimResponsabiliteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.updateResponsabilite(id, dto, user);
  }
}
