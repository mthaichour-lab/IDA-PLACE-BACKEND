import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerHead } from './entities/ledger-head.entity';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

/**
 * LedgerModule — B.2/B.3. Écran 13 "Journal scellé". Chaînage HMAC persisté
 * en base (append-only garanti par trigger, ancre de tête), voir
 * `ledger.service.ts` et `Migration20261020000100_LedgerIntegrity.ts`. Repli
 * mémoire en développement uniquement. `LedgerService.append(type, ref,
 * actor, summary)` est exporté pour les autres modules (actes financiers,
 * disciplinaires et de gouvernance).
 */
@Module({
  imports: [MikroOrmModule.forFeature([LedgerEntry, LedgerHead])],
  controllers: [LedgerController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
