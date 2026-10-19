import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { AdherentsModule } from '../adherents/adherents.module';
import { LedgerModule } from '../ledger/ledger.module';
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
  // AdherentsModule : catalogue des motifs d'opposition (contrôle du `reasonCode`).
  // LedgerModule : scellement de chaque transition (SEC-17) — n'importe aucun module métier, pas de cycle.
  imports: [MikroOrmModule.forFeature([Recours]), RealtimeModule, AdherentsModule, LedgerModule],
  controllers: [RecoursController],
  providers: [RecoursService],
  exports: [RecoursService],
})
export class RecoursModule {}
