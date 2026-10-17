import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
import { LedgerService } from './ledger.service';

/** LedgerModule — écran 13 "Journal scellé" (chaînage SHA-256 append-only, voir ledger.service.ts). */
@ApiTags('ledger')
@ApiBearerAuth()
@Controller('ledger')
@UseGuards(AuthGuard)
export class LedgerController {
  constructor(private readonly service: LedgerService) {}

  @Get()
  @ApiOperation({ summary: 'Journal scellé (append-only), filtrable par période' })
  list(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.list(from, to);
  }

  @Get('verify')
  @ApiOperation({ summary: 'Vérifie le chaînage d’empreintes (intégrité append-only)' })
  verify() {
    return this.service.verifyChain();
  }
}
