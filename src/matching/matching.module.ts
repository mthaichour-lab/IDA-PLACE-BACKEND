import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { MatchingController } from './matching.controller';
import { MatchQueueItem } from './entities/match-queue-item.entity';
import { MatchingService } from './matching.service';

/**
 * MatchingModule — B.2. Écran 2. Clé d'appariement + score pondéré (B.5),
 * persistance réelle (`MatchQueueItem`). Voir `matching.service.ts` et
 * `matching.scoring.ts` (fonctions pures testées).
 */
@Module({
  imports: [MikroOrmModule.forFeature([MatchQueueItem]), RealtimeModule],
  controllers: [MatchingController],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
