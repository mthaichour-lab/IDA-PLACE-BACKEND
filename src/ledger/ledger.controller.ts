import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { RouteThrottle } from '../common/throttle/route-throttle';
import { PLACE_LEVEL_ROLES } from '../common/rbac/roles-privileges';
import { ListLedgerQueryDto } from './dto/ledger-query.dto';
import { LedgerService } from './ledger.service';

/**
 * LedgerModule — écran 13 "Journal scellé" (voir ledger.service.ts).
 *
 * SEC-16 (revue sécurité 2026-10-19) : AVANT, lecture et vérification
 * étaient ouvertes à tout utilisateur authentifié, sans pagination. Désormais :
 *  - `GET /ledger` : rôles de place (dont `AUDITEUR_CSA`), paginé
 *    (`{page,total,items}`, `pageSize` ≤ 100), `from`/`to` en ISO 8601 ;
 *  - `GET /ledger/verify` : administration et audit uniquement
 *    (`OPERATEUR_PLACE`, `ADMIN_UAR`, `AUDITEUR_CSA`), résultat mis en cache ;
 *  - un rôle compagnie reçoit 403 sur les deux routes.
 */
@ApiTags('ledger')
@ApiBearerAuth()
@Controller('ledger')
export class LedgerController {
  constructor(private readonly service: LedgerService) {}

  @Get()
  @Roles(...PLACE_LEVEL_ROLES)
  @ApiOperation({ summary: 'Journal scellé (append-only), paginé et filtrable par période — rôles de place et auditeur' })
  list(@Query() query: ListLedgerQueryDto) {
    return this.service.list(query);
  }

  @Get('verify')
  @Roles('OPERATEUR_PLACE', 'ADMIN_UAR', 'AUDITEUR_CSA')
  // SEC-13 : vérification complète du chaînage, coûteuse — limite stricte (route-throttle.ts).
  @RouteThrottle('LEDGER_VERIFY')
  @ApiOperation({ summary: 'Vérifie le chaînage et l’ancre de tête (intégrité append-only) — administration et audit' })
  verify() {
    return this.service.verifyChain();
  }
}
