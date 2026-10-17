import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { RecoursModule } from '../recours/recours.module';
import { SettlementClosure } from './entities/settlement-closure.entity';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';

/**
 * SettlementModule — B.2. Écrans 5 "Cycle mensuel" et 6 "Compensation
 * trimestrielle". Dépend de `RecoursModule` (lecture seule, interface
 * publique) pour calculer les synthèses et la compensation multilatérale —
 * jamais l'inverse (pas de cycle, voir ARCHITECTURE.md).
 */
@Module({
  imports: [MikroOrmModule.forFeature([SettlementClosure]), RecoursModule],
  controllers: [SettlementController],
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
