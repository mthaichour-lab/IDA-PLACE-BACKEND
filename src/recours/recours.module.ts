import { Body, Controller, Get, Module, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Privileges } from '../common/decorators/privileges.decorator';
import { PaginationQueryDto, paginateArray } from '../common/dto/pagination.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';

const MOCK_RECOURS = Array.from({ length: 9 }).map((_, i) => ({
  id: `rec-${i + 1}`,
  claimId: `clm-${1000 + i}`,
  from: ['CAAT', 'SAA', 'CASH'][i % 3],
  to: ['SAA', 'CASH', 'CAAT'][i % 3],
  state: ['ENVOYE', 'EN_ATTENTE', 'OPPOSITION', 'CONTESTATION', 'COMMISSION', 'FORCLOS'][i % 6],
  requestSentAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
  amount: 60000 + i * 4200,
  // countdownBar front : jours restants avant Art.10 (silence=acceptation) / Art.19 (forclusion)
  conventionalDeadlineAt: new Date(Date.UTC(2026, 1, i + 1)).toISOString(),
}));

/**
 * RecoursModule — écran 4 "Échanges Annexes 2/3/4", B.2.
 * TODO(backend-agent): voir §B.2/B.3 "Recours" + Art. 10 (silence =
 * acceptation), Art. 12 (opposition réputée fondée), Art. 19 (forclusion) :
 * persister l'entité Recours, calculer réellement les timers
 * conventionnels, émettre `recours.timer` (RealtimeModule).
 */
@ApiTags('recours')
@ApiBearerAuth()
@Controller('recours')
@UseGuards(AuthGuard, PrivilegesGuard)
class RecoursController {
  @Get()
  @ApiOperation({ summary: 'Registre des recours (Annexes 2/3/4), paginé (6/p), filtrable par état' })
  list(@Query() q: PaginationQueryDto, @Query('state') state?: string) {
    const rows = state ? MOCK_RECOURS.filter((r) => r.state === state) : MOCK_RECOURS;
    return paginateArray(rows, q.page, q.pageSize);
  }

  @Post(':id/transition')
  @Privileges('exchange')
  @ApiOperation({ summary: "Transition d'état d'un recours (envoi, opposition, contestation, commission...)" })
  transition(@Param('id') id: string, @Body() body: { toState: string }) {
    return { id, state: body.toState, transitionedAt: new Date().toISOString() };
  }
}

@Module({ controllers: [RecoursController] })
export class RecoursModule {}
