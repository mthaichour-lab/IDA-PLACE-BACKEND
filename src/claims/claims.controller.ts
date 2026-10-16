import { Controller, Get, Param, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { ClaimsService } from './claims.service';
import { ClaimImportReportDto } from './dto/claim-import.dto';
import { ListClaimsQueryDto } from './dto/claim.dto';

/**
 * ClaimsModule — écrans 2 (matching) et 3 (import). Contrat stable
 * (§B.4, B.11) : voir TODO détaillés dans `claims.service.ts`.
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

  @Post('import')
  @Privileges('import')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Import Excel/CSV (47 colonnes) → rapport d’éligibilité ligne à ligne (B.4)' })
  @ApiOkResponse({ type: ClaimImportReportDto })
  @UseInterceptors(FileInterceptor('file'))
  // TODO(backend-agent): remplacer le mock par le parsing réel du fichier
  // (`file.buffer`) + délégation à EligibilityModule. Voir claims.service.ts.
  importFile(@UploadedFile() file?: { originalname?: string; size?: number }): ClaimImportReportDto {
    return this.service.buildMockImportReport(file?.originalname ?? 'import.xlsx');
  }

  @Get()
  @ApiOperation({ summary: 'Liste paginée des dossiers (6/p), filtrable par compagnie/état' })
  list(@Query() q: ListClaimsQueryDto) {
    return this.service.list(q);
  }

  @Get(':id')
  @ApiOperation({ summary: "Détail d'un dossier" })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }
}
