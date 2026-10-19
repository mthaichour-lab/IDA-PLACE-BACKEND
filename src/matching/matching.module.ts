import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { AdherentsModule } from '../adherents/adherents.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MatchingController } from './matching.controller';
import { MatchDecision } from './entities/match-decision.entity';
import { MatchQueueItem } from './entities/match-queue-item.entity';
import { MatchingService } from './matching.service';

/**
 * MatchingModule — B.2. Écran 2. Clé d'appariement + score pondéré (B.5),
 * persistance réelle (`MatchQueueItem`). Voir `matching.service.ts` et
 * `matching.scoring.ts` (fonctions pures testées).
 */
@Module({
  // AdherentsModule : barème Art. 14 publié (taux selon barème, écran 2).
  imports: [MikroOrmModule.forFeature([MatchQueueItem, MatchDecision]), RealtimeModule, AdherentsModule],
  controllers: [MatchingController],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
