import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Controller, Get, Module, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
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
 */
@ApiTags('fraud')
@ApiBearerAuth()
@Controller('fraud')
@UseGuards(AuthGuard)
class FraudController {
  constructor(private readonly service: FraudService) {}

  @Get('cases')
  @ApiOperation({ summary: 'File des cas suspects (réel : doublons, e-constat réutilisé, récurrence véhicule, montants calibrés, incohérences A/B), triée par score desc, paginée (6/p)' })
  cases(@Query() q: PaginationQueryDto) {
    return this.service.cases(q.page, q.pageSize);
  }

  @Get('actions')
  @ApiOperation({ summary: 'Journal des actions suspectes de place (réel : appariement manuel/déliage/reliage observés sur MatchingModule, transmissions tardives), paginé (6/p)' })
  actions(@Query() q: PaginationQueryDto) {
    return this.service.actions(q.page, q.pageSize);
  }

  @Get('adherents/:company/signals')
  @ApiOperation({ summary: 'Signaux groupés par catégorie pour un adhérent (écran 9, panneau de détail) — Doublons & e-constat / Réseau-récurrence / Montants & plafond / Incohérences A/B / Vélocité' })
  signalsByAdherent(@Param('company') company: string) {
    return this.service.signalsByAdherent(company);
  }
}

@Module({
  imports: [MikroOrmModule.forFeature([FraudCase, FraudAction]), ClaimsModule, MatchingModule, RealtimeModule],
  controllers: [FraudController],
  providers: [FraudService],
})
export class FraudModule {}
