import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import mikroOrmConfig from '../mikro-orm.config';
import { AdherentsModule } from './adherents/adherents.module';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CacheModule } from './common/cache/cache.module';
import { ClaimsModule } from './claims/claims.module';
import { CockpitModule } from './cockpit/cockpit.module';
import { CommissionModule } from './commission/commission.module';
import { DocumentsModule } from './documents/documents.module';
import { EligibilityModule } from './eligibility/eligibility.module';
import { ExpertsModule } from './experts/experts.module';
import { FraudModule } from './fraud/fraud.module';
import { LedgerModule } from './ledger/ledger.module';
import { MatchingModule } from './matching/matching.module';
import { MeteringModule } from './metering/metering.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RecoursModule } from './recours/recours.module';
import { SettlementModule } from './settlement/settlement.module';
import { StatsModule } from './stats/stats.module';

/**
 * AppModule — enregistre les 17 modules métier de B.2 + `CockpitModule`
 * (module agrégateur additionnel, voir son fichier). Voir ARCHITECTURE.md
 * pour l'état d'avancement module par module (réel / mocké).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MikroOrmModule.forRoot(mikroOrmConfig),
    CacheModule,

    // --- 17 modules B.2 ---
    AuthModule,
    AdherentsModule,
    ExpertsModule,
    ClaimsModule,
    EligibilityModule,
    MatchingModule,
    RecoursModule,
    SettlementModule,
    CommissionModule,
    MonitoringModule,
    FraudModule,
    MeteringModule,
    StatsModule,
    LedgerModule,
    AdminModule,
    DocumentsModule,
    RealtimeModule,

    // --- module agrégateur additionnel (écran 1) ---
    CockpitModule,
  ],
})
export class AppModule {}
