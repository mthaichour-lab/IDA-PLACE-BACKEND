import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { buildMikroOrmConfig } from './common/config/database.config';
import { AuthGuard } from './common/guards/auth.guard';
import { PrivilegesGuard } from './common/guards/privileges.guard';
import { AdherentsModule } from './adherents/adherents.module';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CacheModule } from './common/cache/cache.module';
import { EnvValidationModule } from './common/config/env-validation.module';
import { getThrottleSettings } from './common/config/env.validation';
import { HealthModule } from './common/health/health.module';
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
 *
 * Socle sécurité (revue 2026-10-19) :
 *  - `EnvValidationModule` : validation de la configuration à la compilation
 *    (SEC-01/SEC-23) — démarrage refusé si la configuration est dangereuse ;
 *  - MikroORM configuré à la compilation (`forRootAsync`), APRÈS le
 *    chargement du `.env` par `ConfigModule` (auparavant la configuration
 *    était figée à l'import, avant le `.env`) ;
 *  - `ThrottlerGuard` global (SEC-13), réglé par `THROTTLE_*` ; limites plus
 *    strictes par route via `@RouteThrottle` (`common/throttle/route-throttle.ts`),
 *    soumises au même interrupteur `skipIf` ;
 *  - `AuthGuard` puis `PrivilegesGuard` GLOBAUX (SEC-43), dans cet ordre et
 *    après le throttler : toute route est authentifiée et doit déclarer son
 *    accès (`@Privileges`, `@Roles`, `@Authenticated` ou `@Public`) — fermé
 *    par défaut, même pour un contrôleur qui oublierait `@UseGuards` ;
 *  - `HealthModule` : sondes `/health/live` et `/health/ready` (SEC-08).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EnvValidationModule,
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      useFactory: () => buildMikroOrmConfig(process.env),
    }),
    ThrottlerModule.forRootAsync({
      useFactory: () => {
        const settings = getThrottleSettings();
        return {
          throttlers: [{ name: 'default', ttl: settings.ttlMs, limit: settings.limit }],
          skipIf: () => !settings.enabled,
        };
      },
    }),
    CacheModule,
    HealthModule,

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
  // L'ordre compte : limitation de débit (y compris des requêtes non authentifiées), puis authentification, puis droits.
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PrivilegesGuard },
  ],
})
export class AppModule {}
