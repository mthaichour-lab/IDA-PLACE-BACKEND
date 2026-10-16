import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { AdherentsController } from './adherents.controller';
import { AdherentsService } from './adherents.service';
import { Agency } from './entities/agency.entity';
import { Company } from './entities/company.entity';
import { Wilaya } from './entities/wilaya.entity';

/** AdherentsModule — B.2 : adhérents/compagnies, agences, wilayas. Écran 12. */
@Module({
  imports: [MikroOrmModule.forFeature([Company, Agency, Wilaya])],
  controllers: [AdherentsController],
  providers: [AdherentsService],
  exports: [AdherentsService],
})
export class AdherentsModule {}
