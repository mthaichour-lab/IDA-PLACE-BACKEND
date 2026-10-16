import { createHash } from 'crypto';
import { Controller, Get, Injectable, Module, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';

interface LedgerEntry {
  id: string;
  type: string;
  ref: string;
  actor: string;
  summary: string;
  at: string;
  hash: string;
  prevHash: string | null;
}

const GENESIS_HASH = '0'.repeat(64);

function computeHash(entry: Omit<LedgerEntry, 'hash'>): string {
  return createHash('sha256')
    .update(`${entry.id}|${entry.type}|${entry.ref}|${entry.actor}|${entry.summary}|${entry.at}|${entry.prevHash}`)
    .digest('hex');
}

/**
 * LedgerModule — écran 13 "Journal scellé", B.2/B.3.
 *
 * Chaînage d'empreintes RÉEL (hash(n) = sha256(événement ‖ hash(n-1)) —
 * logique simple suffisamment auto-portante pour être implémentée dans ce
 * socle, contrairement aux modules métier complexes (Claims, Matching...).
 *
 * TODO(backend-agent): remplacer le stockage en mémoire (`entries`) par une
 * table `LedgerEntry` append-only (migration MikroORM), avec contrainte
 * d'immutabilité en base (pas de UPDATE/DELETE applicatif), et brancher les
 * autres modules pour qu'ils appellent `LedgerService.append(...)` à chaque
 * événement significatif (décision de matching, transition de recours,
 * clôture mensuelle, sanction...).
 */
@Injectable()
export class LedgerService {
  private entries: LedgerEntry[] = this.seed();

  private seed(): LedgerEntry[] {
    const seeded: LedgerEntry[] = [];
    let prevHash: string | null = null;
    const seedData = [
      { type: 'SYSTEM', ref: 'BOOT', actor: 'system', summary: 'Initialisation du journal scellé' },
      { type: 'CLAIM', ref: 'clm-1000', actor: 'import@caat.dz', summary: 'Dossier ingéré via import 47 colonnes' },
      { type: 'MATCH', ref: 'mtc-2000', actor: 'operateur@finlab.dz', summary: 'Confrontation confirmée manuellement' },
    ];
    for (const [i, s] of seedData.entries()) {
      const at = new Date(Date.UTC(2026, 0, 1, i)).toISOString();
      const base = { id: `ldg-${i + 1}`, ...s, at, prevHash: prevHash ?? GENESIS_HASH };
      const hash = computeHash(base);
      const entry = { ...base, hash };
      seeded.push(entry);
      prevHash = hash;
    }
    return seeded;
  }

  append(type: string, ref: string, actor: string, summary: string): LedgerEntry {
    const prevHash = this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS_HASH;
    const base = { id: `ldg-${this.entries.length + 1}`, type, ref, actor, summary, at: new Date().toISOString(), prevHash };
    const entry = { ...base, hash: computeHash(base) };
    this.entries.push(entry);
    return entry;
  }

  list(from?: string, to?: string): LedgerEntry[] {
    return this.entries.filter((e) => (!from || e.at >= from) && (!to || e.at <= to));
  }

  /** Vérifie l'intégrité du chaînage (recalcule chaque hash). Utilisé par l'export / l'audit. */
  verifyChain(): { valid: boolean; brokenAt?: string } {
    let prevHash: string | null = null;
    for (const e of this.entries) {
      const expectedPrev = prevHash ?? GENESIS_HASH;
      if (e.prevHash !== expectedPrev) return { valid: false, brokenAt: e.id };
      const recomputed = computeHash({ id: e.id, type: e.type, ref: e.ref, actor: e.actor, summary: e.summary, at: e.at, prevHash: e.prevHash });
      if (recomputed !== e.hash) return { valid: false, brokenAt: e.id };
      prevHash = e.hash;
    }
    return { valid: true };
  }
}

@ApiTags('ledger')
@ApiBearerAuth()
@Controller('ledger')
@UseGuards(AuthGuard)
class LedgerController {
  constructor(private readonly service: LedgerService) {}

  @Get()
  @ApiOperation({ summary: 'Journal scellé (append-only), filtrable par période' })
  list(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.list(from, to);
  }

  @Get('verify')
  @ApiOperation({ summary: 'Vérifie le chaînage d’empreintes (intégrité append-only)' })
  verify() {
    return this.service.verifyChain();
  }
}

@Module({ controllers: [LedgerController], providers: [LedgerService], exports: [LedgerService] })
export class LedgerModule {}
