import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { RecoursModule } from '../recours/recours.module';
import { CommissionController } from './commission.controller';
import { CommissionService } from './commission.service';
import { CommissionCase } from './entities/commission-case.entity';
import { Sanction } from './entities/sanction.entity';

/**
 * CommissionModule — B.2. Écran 7 "Commission". Dépend de `RecoursModule`
 * (lecture seule, interface publique) pour valider/dénormaliser un dossier
 * de conciliation à l'ouverture — jamais l'inverse (pas de cycle, voir
 * ARCHITECTURE.md et commission.service.ts).
 */
@Module({
  imports: [MikroOrmModule.forFeature([CommissionCase, Sanction]), RecoursModule],
  controllers: [CommissionController],
  providers: [CommissionService],
  exports: [CommissionService],
})
export class CommissionModule {}
