import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';

/**
 * FraudModule — écran 9 "Anti-fraude", B.2/B.9.
 * TODO(backend-agent): voir §B.9, implémenter la détection réelle
 * (doublons, e-constat réutilisé, récurrence de véhicule, montants
 * calibrés sous plafond, incohérences A/B, rafales d'alimentation) et le
 * journal des actions suspectes de place (appariement manuel, déliage/
 * reliage, transmission tardive).
 */
@ApiTags('fraud')
@ApiBearerAuth()
@Controller('fraud')
@UseGuards(AuthGuard)
class FraudController {
  @Get('cases')
  @ApiOperation({ summary: 'File des cas suspects, priorisée par gravité (mock)' })
  cases() {
    return Array.from({ length: 6 }).map((_, i) => ({
      id: `frd-${i + 1}`,
      severity: ['ELEVEE', 'MOYENNE', 'FAIBLE'][i % 3],
      signals: ['Doublons & e-constat', 'Réseau/récurrence', 'Montants & plafond', 'Incohérences A/B', 'Vélocité'].slice(0, (i % 5) + 1),
      companiesInvolved: ['CAAT', 'SAA'].slice(0, (i % 2) + 1),
      detectedAt: new Date(Date.UTC(2026, 0, 10 + i)).toISOString(),
    }));
  }

  @Get('actions')
  @ApiOperation({ summary: 'Journal des actions suspectes de place (mock)' })
  actions() {
    return Array.from({ length: 6 }).map((_, i) => ({
      id: `act-${i + 1}`,
      type: ['APPARIEMENT_MANUEL', 'DELIAGE', 'RELIAGE', 'TRANSMISSION_TARDIVE'][i % 4],
      actor: `agent-${(i % 3) + 1}@finlab.dz`,
      at: new Date(Date.UTC(2026, 0, 5 + i)).toISOString(),
    }));
  }
}

@Module({ controllers: [FraudController] })
export class FraudModule {}
