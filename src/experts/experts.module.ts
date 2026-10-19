import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { Expert } from './entities/expert.entity';
import { ExpertsController } from './experts.controller';
import { ExpertsService } from './experts.service';

/** ExpertsModule — B.2 : registre des experts de place. Écran 12. */
@Module({
  imports: [MikroOrmModule.forFeature([Expert]), LedgerModule],
  controllers: [ExpertsController],
  providers: [ExpertsService],
  exports: [ExpertsService],
})
export class ExpertsModule {}
