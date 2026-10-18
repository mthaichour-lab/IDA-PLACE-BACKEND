import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { AdherentsModule } from '../adherents/adherents.module';
import { RecoursModule } from '../recours/recours.module';
import { CommissionController } from './commission.controller';
import { CommissionService } from './commission.service';
import { CommissionCase } from './entities/commission-case.entity';
import { MembershipRequest } from './entities/membership-request.entity';
import { Sanction } from './entities/sanction.entity';
import { MembershipController } from './membership.controller';
import { MembershipService } from './membership.service';

/**
 * CommissionModule — B.2. Écran 7 "Commission". Dépend de `RecoursModule`
 * (lecture seule, interface publique) pour valider/dénormaliser un dossier
 * de conciliation à l'ouverture, et d'`AdherentsModule` pour les adhésions
 * et retraits — jamais l'inverse (pas de cycle, voir ARCHITECTURE.md et
 * commission.service.ts).
 */
@Module({
  imports: [MikroOrmModule.forFeature([CommissionCase, Sanction, MembershipRequest]), RecoursModule, AdherentsModule],
  controllers: [CommissionController, MembershipController],
  providers: [CommissionService, MembershipService],
  exports: [CommissionService],
})
export class CommissionModule {}
