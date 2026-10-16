import { Controller, Get, Module, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';

/**
 * SettlementModule — écrans 5 "Cycle mensuel" et 6 "Compensation
 * trimestrielle", B.2.
 * TODO(backend-agent): voir §B.2/B.3, implémenter le cycle mensuel réel
 * (synthèses par compagnie, clôtures, bordereaux) et la compensation
 * multilatérale trimestrielle (positions bilatérales → net à payer/recevoir,
 * grille tarifaire TARIF-2026.01).
 */
@ApiTags('settlement')
@ApiBearerAuth()
@Controller('settlement')
@UseGuards(AuthGuard)
class SettlementController {
  @Get('monthly/:period')
  @ApiOperation({ summary: 'Synthèse mensuelle par compagnie (ex: period=2026-01)' })
  monthly(@Param('period') period: string) {
    return {
      period,
      companies: ['CAAT', 'SAA', 'CASH', 'ALLI'].map((code, i) => ({
        code,
        claimsCount: 40 + i * 9,
        totalAmount: 2_300_000 + i * 410_000,
        status: i % 3 === 0 ? 'CLOTURE' : 'EN_COURS',
      })),
    };
  }

  @Get('quarter/:q')
  @ApiOperation({ summary: 'Compensation trimestrielle — positions bilatérales et nettes (ex: q=2026-Q1)' })
  quarter(@Param('q') q: string) {
    const companies = ['CAAT', 'SAA', 'CASH', 'ALLI'];
    return {
      quarter: q,
      bordereau: `BORD-${q}`,
      positions: companies.flatMap((a, i) =>
        companies
          .filter((b) => b !== a)
          .map((b, j) => ({ from: a, to: b, amount: 150000 + (i + j) * 23000 })),
      ),
      net: companies.map((code, i) => ({ code, net: (i % 2 === 0 ? 1 : -1) * (80000 + i * 15000) })),
    };
  }
}

@Module({ controllers: [SettlementController] })
export class SettlementModule {}
