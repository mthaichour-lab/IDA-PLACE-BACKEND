import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Controller, Get, Module, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { ClaimsModule } from '../claims/claims.module';
import { MatchingModule } from '../matching/matching.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { FraudAction } from './entities/fraud-action.entity';
import { FraudCase } from './entities/fraud-case.entity';
import { FraudService } from './fraud.service';
import { CompanyParamDto, StrictQuery } from '../claims/dto/strict-query.pipe';
import { Roles } from '../common/decorators/roles.decorator';
import { PLACE_LEVEL_ROLES } from '../common/rbac/roles-privileges';

/**
 * FraudModule — écran 9 "Anti-fraude", B.2/B.9. Détection RÉELLE (5 règles,
 * voir `fraud.detection.ts`) et journal des actions suspectes RÉEL (voir
 * `fraud.service.ts`), persistés (`FraudCase`/`FraudAction`, repli mémoire
 * en mode dégradé).
 *
 * Revue sécurité 2026-10-18 (B.7) : `cases()`/`signalsByAdherent()`
 * désormais scopées (`FraudCase.companiesInvolved`, même principe que
 * `from`/`to` ailleurs — un cas reste visible à une compagnie-partie même
 * s'il nomme aussi une autre compagnie, car la détection de fraude est par
 * nature inter-compagnies, voir fraud.detection.ts) ; SEC-26 : une
 * compagnie n'y reçoit que ses dossiers et le nombre de contreparties.
 * `actions()` (journal des actions suspectes de PLACE, `actor` à typage
 * mixte — QUESTIONS_UAR.md §13) : SEC-21, réservé aux rôles place.
 */
@ApiTags('fraud')
@ApiBearerAuth()
@Controller('fraud')
@UseGuards(AuthGuard, PrivilegesGuard)
class FraudController {
  constructor(private readonly service: FraudService) {}

  @Get('cases')
  @ApiOperation({ summary: 'File des cas suspects (réel : doublons, e-constat réutilisé, récurrence véhicule, montants calibrés, incohérences A/B), triée par score desc, paginée (6/p) — B.7 : scopée par compagnie partie au cas' })
  @StrictQuery(PaginationQueryDto)
  cases(@Query() q: PaginationQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.cases(q.page, q.pageSize, user);
  }

  // SEC-21 : audit trail de place (e-mails/noms d'agents, retards de
  // transmission de toutes les compagnies) — réservé aux rôles place, 403
  // pour un rôle compagnie (décision PO 2026-10-18 : « audit trail de place »).
  @Get('actions')
  @Roles(...PLACE_LEVEL_ROLES)
  @ApiOperation({ summary: 'Journal des actions suspectes de place (appariement manuel/déliage/reliage, transmissions tardives), paginé (6/p) — réservé aux rôles place (SEC-21)' })
  @StrictQuery(PaginationQueryDto)
  actions(@Query() q: PaginationQueryDto) {
    return this.service.actions(q.page, q.pageSize);
  }

  @Get('adherents/:company/signals')
  @ApiOperation({ summary: 'Signaux groupés par catégorie pour un adhérent (écran 9, panneau de détail) — Doublons & e-constat / Réseau-récurrence / Montants & plafond / Incohérences A/B / Vélocité — B.7 : scopée par compagnie' })
  signalsByAdherent(@Param() p: CompanyParamDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.signalsByAdherent(p.company, user);
  }
}

@Module({
  imports: [MikroOrmModule.forFeature([FraudCase, FraudAction]), ClaimsModule, MatchingModule, RealtimeModule],
  controllers: [FraudController],
  providers: [FraudService],
})
export class FraudModule {}
