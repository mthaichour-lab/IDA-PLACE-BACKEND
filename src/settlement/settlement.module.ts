import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { AdherentsModule } from '../adherents/adherents.module';
import { RecoursModule } from '../recours/recours.module';
import { SettlementClosure } from './entities/settlement-closure.entity';
import { SettlementPipelineStep } from './entities/settlement-pipeline-step.entity';
import { SettlementPipelineService } from './settlement-pipeline.service';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';

/**
 * SettlementModule — B.2. Écrans 5 "Cycle mensuel" et 6 "Compensation
 * trimestrielle". Dépend de `RecoursModule` (lecture seule, interface
 * publique) pour calculer les synthèses et la compensation multilatérale,
 * et d'`AdherentsModule` pour le calendrier ouvré de l'avancement du lot —
 * jamais l'inverse (pas de cycle, voir ARCHITECTURE.md).
 */
@Module({
  imports: [MikroOrmModule.forFeature([SettlementClosure, SettlementPipelineStep]), RecoursModule, AdherentsModule],
  controllers: [SettlementController],
  providers: [SettlementService, SettlementPipelineService],
  exports: [SettlementService],
})
export class SettlementModule {}
