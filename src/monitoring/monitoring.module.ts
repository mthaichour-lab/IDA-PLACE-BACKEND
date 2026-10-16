import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';

const WEIGHTS = { delais: 0.3, silences: 0.15, oppositions: 0.15, qualiteDonnees: 0.15, forclusions: 0.1, demandesTardives: 0.1, penalites: 0.05 };

/**
 * MonitoringModule — écran 8 "Monitoring assureurs", B.2.
 * TODO(backend-agent): voir §B.2, calculer réellement le scoring composite
 * (pondérations ci-dessus — B.2 écran 8) à partir de RecoursModule et
 * CommissionModule, exposer le parcours inter-compagnies par dossier.
 */
@ApiTags('monitoring')
@ApiBearerAuth()
@Controller('monitoring')
@UseGuards(AuthGuard)
class MonitoringController {
  @Get('scores')
  @ApiOperation({ summary: 'Scoring composite de conformité par compagnie (mock, pondérations réelles)' })
  scores() {
    return {
      weights: WEIGHTS,
      companies: ['CAAT', 'SAA', 'CASH', 'ALLI'].map((code, i) => ({
        code,
        score: 92 - i * 7,
        rank: i + 1,
        details: { delais: 95 - i * 5, silences: 90 - i * 4, oppositions: 88 - i * 3, qualiteDonnees: 91 - i * 2, forclusions: 97, demandesTardives: 85, penalites: 100 - i * 10 },
      })),
    };
  }
}

@Module({ controllers: [MonitoringController] })
export class MonitoringModule {}
