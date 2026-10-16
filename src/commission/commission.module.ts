import { Body, Controller, Get, Module, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';

/**
 * CommissionModule — écran 7 "Commission", B.2.
 * TODO(backend-agent): voir §B.2, implémenter la file de conciliation
 * réelle, le prononcé de pénalités/sanctions (lié à MonitoringModule) et la
 * génération des PV de commission (lié à DocumentsModule).
 */
@ApiTags('commission')
@ApiBearerAuth()
@Controller('commission')
@UseGuards(AuthGuard, PrivilegesGuard)
class CommissionController {
  @Get('cases')
  @ApiOperation({ summary: 'File de conciliation (mock)' })
  cases() {
    return Array.from({ length: 5 }).map((_, i) => ({
      id: `com-${i + 1}`,
      recoursId: `rec-${i + 1}`,
      status: ['A_INSTRUIRE', 'EN_DELIBERE', 'PRONONCE'][i % 3],
      scheduledAt: new Date(Date.UTC(2026, 1, 3 + i)).toISOString(),
    }));
  }

  @Post(':id/penalty')
  @Privileges('penaltyOrder')
  @ApiOperation({ summary: 'Prononcé de pénalité' })
  penalty(@Param('id') id: string, @Body() body: { amount: number; reason: string }) {
    return { id, ...body, orderedAt: new Date().toISOString() };
  }

  @Post(':id/pv-sign')
  @Privileges('pvSign')
  @ApiOperation({ summary: 'Signature du PV de commission' })
  sign(@Param('id') id: string) {
    return { id, signedAt: new Date().toISOString() };
  }
}

@Module({ controllers: [CommissionController] })
export class CommissionModule {}
