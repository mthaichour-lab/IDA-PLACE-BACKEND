import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

/**
 * LedgerModule — B.2/B.3. Écran 13 "Journal scellé". Chaînage SHA-256
 * désormais persisté en base (append-only, voir `ledger.service.ts` et la
 * migration `Migration20260301000000_RecoursSettlementCommissionLedger.ts`),
 * avec repli mémoire déterministe en mode dégradé (même comportement que
 * l'ancienne version 100% mémoire). API publique (`GET /ledger`,
 * `GET /ledger/verify`) inchangée.
 */
@Module({
  imports: [MikroOrmModule.forFeature([LedgerEntry])],
  controllers: [LedgerController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
