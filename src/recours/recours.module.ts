import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { Recours } from './entities/recours.entity';
import { RecoursController } from './recours.controller';
import { RecoursService } from './recours.service';

/**
 * RecoursModule — B.2. Écran 4 "Échanges Annexes 2/3/4". Timers
 * conventionnels (Art.10/12/19) + persistance réelle (`Recours`). Exporte
 * `RecoursService` : `SettlementModule` (compensation, à partir des recours
 * réglés) et `CommissionModule` (dénormalisation à l'ouverture d'un dossier
 * de conciliation) en dépendent — toujours dans ce sens, jamais l'inverse
 * (pas de cycle, voir ARCHITECTURE.md).
 */
@Module({
  imports: [MikroOrmModule.forFeature([Recours]), RealtimeModule],
  controllers: [RecoursController],
  providers: [RecoursService],
  exports: [RecoursService],
})
export class RecoursModule {}
