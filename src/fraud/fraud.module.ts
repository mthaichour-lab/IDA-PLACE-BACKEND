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
 * nature inter-compagnies, voir fraud.detection.ts). `actions()`
 * (journal des actions suspectes de PLACE) reste volontairement NON
 * scopée : `FraudAction.actor` est soit un identifiant utilisateur (décision
 * humaine), soit un code compagnie (transmission tardive) — pas un champ
 * compagnie fiable pour filtrer, et ce journal est par nature un audit
 * trail de place (même esprit que LedgerModule) — point à trancher avec le
 * métier si un scoping est réellement souhaité (voir QUESTIONS_UAR.md).
 */
@ApiTags('fraud')
@ApiBearerAuth()
@Controller('fraud')
@UseGuards(AuthGuard, PrivilegesGuard)
class FraudController {
  constructor(private readonly service: FraudService) {}

  @Get('cases')
  @ApiOperation({ summary: 'File des cas suspects (réel : doublons, e-constat réutilisé, récurrence véhicule, montants calibrés, incohérences A/B), triée par score desc, paginée (6/p) — B.7 : scopée par compagnie partie au cas' })
  cases(@Query() q: PaginationQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.cases(q.page, q.pageSize, user);
  }

  @Get('actions')
  @ApiOperation({ summary: 'Journal des actions suspectes de place (réel : appariement manuel/déliage/reliage observés sur MatchingModule, transmissions tardives), paginé (6/p) — volontairement place-wide, voir doc de classe' })
  actions(@Query() q: PaginationQueryDto) {
    return this.service.actions(q.page, q.pageSize);
  }

  @Get('adherents/:company/signals')
  @ApiOperation({ summary: 'Signaux groupés par catégorie pour un adhérent (écran 9, panneau de détail) — Doublons & e-constat / Réseau-récurrence / Montants & plafond / Incohérences A/B / Vélocité — B.7 : scopée par compagnie' })
  signalsByAdherent(@Param('company') company: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.signalsByAdherent(company, user);
  }
}

@Module({
  imports: [MikroOrmModule.forFeature([FraudCase, FraudAction]), ClaimsModule, MatchingModule, RealtimeModule],
  controllers: [FraudController],
  providers: [FraudService],
})
export class FraudModule {}
