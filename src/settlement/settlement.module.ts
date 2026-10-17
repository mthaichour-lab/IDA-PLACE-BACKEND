import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { ClaimsModule } from '../claims/claims.module';
import { MeteringModule } from '../metering/metering.module';
import { CompensationQuarter } from './entities/compensation-quarter.entity';
import { SettlementMonthly } from './entities/settlement-monthly.entity';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';

/**
 * SettlementModule — B.2/B.3. Écrans 5 "Cycle mensuel" et 6 "Compensation
 * trimestrielle". Dépend de `ClaimsModule` (synthèse à partir des dossiers
 * réels) et `MeteringModule` (grille tarifaire TARIF-2026.01, service
 * public réutilisé) — jamais de leurs entités internes (ARCHITECTURE.md §1).
 */
@Module({
  imports: [MikroOrmModule.forFeature([SettlementMonthly, CompensationQuarter]), ClaimsModule, MeteringModule],
  controllers: [SettlementController],
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
