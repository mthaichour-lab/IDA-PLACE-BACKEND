import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { AdherentsController } from './adherents.controller';
import { AdherentsService } from './adherents.service';
import { BaremeReferentialService } from './bareme-referential.service';
import { ConventionReferentialService } from './convention-referential.service';
import { Agency } from './entities/agency.entity';
import { BaremeCase } from './entities/bareme-case.entity';
import { BaremeVersion } from './entities/bareme-version.entity';
import { Company } from './entities/company.entity';
import { ConstatCircumstance } from './entities/constat-circumstance.entity';
import { IrsamBenchmark } from './entities/irsam-benchmark.entity';
import { MobileHoliday } from './entities/mobile-holiday.entity';
import { OppositionMotif } from './entities/opposition-motif.entity';
import { VehicleCategory } from './entities/vehicle-category.entity';
import { Wilaya } from './entities/wilaya.entity';
import { WilayaPopulation } from './entities/wilaya-population.entity';
import { PlaceMetricsReferentialService } from './place-metrics-referential.service';
import { PlaceReferentialController } from './place-referential.controller';

/**
 * AdherentsModule — B.2 : adhérents/compagnies, agences, wilayas et
 * référentiels de place (écran 12). Seul `AdherentsService` est exporté :
 * les autres modules passent par ses méthodes publiques.
 */
@Module({
  imports: [MikroOrmModule.forFeature([Company, Agency, Wilaya, MobileHoliday, ConstatCircumstance, OppositionMotif, WilayaPopulation, IrsamBenchmark, BaremeVersion, BaremeCase, VehicleCategory])],
  controllers: [AdherentsController, PlaceReferentialController],
  providers: [AdherentsService, ConventionReferentialService, PlaceMetricsReferentialService, BaremeReferentialService],
  exports: [AdherentsService],
})
export class AdherentsModule {}
