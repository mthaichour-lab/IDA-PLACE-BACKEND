import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { EligibilityModule } from '../eligibility/eligibility.module';
import { MatchingModule } from '../matching/matching.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';
import { Claim } from './entities/claim.entity';

/**
 * ClaimsModule — B.2. Écrans 2, 3. Dépend de `EligibilityModule` (verdict
 * ligne à ligne), `MatchingModule` (calcul d'appariement après import) et
 * `RealtimeModule` (événement `claim.ingested`). Toujours dans ce sens
 * (jamais l'inverse) pour éviter tout cycle de modules — voir
 * ARCHITECTURE.md et matching.service.ts.
 */
@Module({
  imports: [MikroOrmModule.forFeature([Claim]), EligibilityModule, MatchingModule, RealtimeModule],
  controllers: [ClaimsController],
  providers: [ClaimsService],
  exports: [ClaimsService],
})
export class ClaimsModule {}
