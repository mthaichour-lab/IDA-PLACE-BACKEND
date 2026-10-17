import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { Recours } from './entities/recours.entity';
import { RecoursController } from './recours.controller';
import { RecoursService } from './recours.service';

/**
 * RecoursModule — B.2/B.3. Écran 4 "Échanges Annexes 2/3/4". Dépend de
 * `LedgerModule` (traçabilité des transitions, manuelles et automatiques)
 * et `RealtimeModule` (événement `recours.timer`). N'importe jamais les
 * entités d'un autre module (ARCHITECTURE.md §1).
 */
@Module({
  imports: [MikroOrmModule.forFeature([Recours]), LedgerModule, RealtimeModule],
  controllers: [RecoursController],
  providers: [RecoursService],
  exports: [RecoursService],
})
export class RecoursModule {}
