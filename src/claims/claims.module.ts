import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { AdherentsModule } from '../adherents/adherents.module';
import { EligibilityModule } from '../eligibility/eligibility.module';
import { MatchingModule } from '../matching/matching.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RecoursModule } from '../recours/recours.module';
import { ClaimsController } from './claims.controller';
import { RecoursOpeningController } from './recours-opening.controller';
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
  // RecoursModule (recours ouvert sur le dossier) et AdherentsModule (barème
  // publié) n'importent jamais ClaimsModule : pas de cycle.
  imports: [MikroOrmModule.forFeature([Claim]), EligibilityModule, MatchingModule, RealtimeModule, RecoursModule, AdherentsModule],
  controllers: [ClaimsController, RecoursOpeningController],
  providers: [ClaimsService],
  exports: [ClaimsService],
})
export class ClaimsModule {}
