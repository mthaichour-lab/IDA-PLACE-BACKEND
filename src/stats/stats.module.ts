import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
import { buildWilayaSeeds } from '../adherents/wilayas.data';

/**
 * StatsModule — écran 11 "Statistiques de la place", B.2.
 * TODO(backend-agent): voir §B.2, agréger réellement les déclarations par
 * wilaya (ClaimsModule) et les séries temporelles (Annexes 2 émises,
 * oppositions, assurés indemnisés, adoption e-constat mobile vs agence) au
 * lieu des valeurs aléatoires déterministes ci-dessous.
 */
@ApiTags('stats')
@ApiBearerAuth()
@Controller('stats')
@UseGuards(AuthGuard)
class StatsController {
  @Get('wilayas')
  @ApiOperation({ summary: 'Carte en tuiles des 69 wilayas (grille 13×8) — déclarations/montants/pour 100k hab. (mock)' })
  wilayas() {
    return buildWilayaSeeds().map((w, i) => ({
      ...w,
      declarations: 20 + ((i * 37) % 480),
      montants: 500000 + ((i * 91333) % 9000000),
      pour100k: 5 + ((i * 13) % 90),
    }));
  }

  @Get('monthly')
  @ApiOperation({ summary: "Activité mensuelle de la place (déclarations, Annexes 2, oppositions, assurés indemnisés) — mock" })
  monthly() {
    return Array.from({ length: 12 }).map((_, i) => ({
      month: `2026-${String(i + 1).padStart(2, '0')}`,
      declarations: 1200 + i * 60,
      annexes2: 900 + i * 40,
      oppositions: 80 + (i % 5) * 10,
      indemnises: 1000 + i * 55,
      econstatMobile: 55 + (i % 10),
      econstatAgence: 45 - (i % 10),
    }));
  }
}

@Module({ controllers: [StatsController] })
export class StatsModule {}
