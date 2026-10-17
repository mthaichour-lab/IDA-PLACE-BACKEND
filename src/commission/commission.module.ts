import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { RecoursModule } from '../recours/recours.module';
import { CommissionController } from './commission.controller';
import { CommissionService } from './commission.service';
import { CommissionPv } from './entities/commission-pv.entity';
import { Sanction } from './entities/sanction.entity';

/**
 * CommissionModule — B.2/B.3. Écran 7 "Commission". Dépend de
 * `RecoursModule` (file de conciliation = recours escaladés, service
 * public réutilisé, jamais son entité) et `LedgerModule` (traçabilité).
 */
@Module({
  imports: [MikroOrmModule.forFeature([Sanction, CommissionPv]), RecoursModule, LedgerModule],
  controllers: [CommissionController],
  providers: [CommissionService],
  exports: [CommissionService],
})
export class CommissionModule {}
