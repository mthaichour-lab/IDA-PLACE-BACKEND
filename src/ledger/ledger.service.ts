import { createHash, randomUUID } from 'crypto';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { LedgerEntry } from './entities/ledger-entry.entity';

export interface LedgerEntryDto {
  id: string;
  type: string;
  ref: string;
  actor: string;
  summary: string;
  at: string;
  hash: string;
  prevHash: string | null;
}

export const GENESIS_HASH = '0'.repeat(64);

function computeHash(entry: { id: string; type: string; ref: string; actor: string; summary: string; at: string; prevHash: string }): string {
  return createHash('sha256')
    .update(`${entry.id}|${entry.type}|${entry.ref}|${entry.actor}|${entry.summary}|${entry.at}|${entry.prevHash}`)
    .digest('hex');
}

const SEED_DATA = [
  { type: 'SYSTEM', ref: 'BOOT', actor: 'system', summary: 'Initialisation du journal scellé' },
  { type: 'CLAIM', ref: 'clm-1000', actor: 'import@caat.dz', summary: 'Dossier ingéré via import 47 colonnes' },
  { type: 'MATCH', ref: 'mtc-2000', actor: 'operateur@finlab.dz', summary: 'Confrontation confirmée manuellement' },
];

/** Repli mémoire — mode dégradé (voir README "Mode dégradé"). Persistant pour la durée du process. */
const MEMORY_ENTRIES: LedgerEntryDto[] = [];

function toDto(e: LedgerEntry): LedgerEntryDto {
  return { id: e.id, type: e.type, ref: e.ref, actor: e.actor, summary: e.summary, at: e.at.toISOString(), prevHash: e.prevHash, hash: e.hash };
}

/**
 * LedgerModule — écran 13 "Journal scellé", B.2/B.3.
 *
 * Chaînage d'empreintes RÉEL (hash(n) = sha256(événement ‖ hash(n-1))),
 * désormais persisté en base (append-only, `LedgerEntry` + migration) avec
 * repli mémoire déterministe en mode dégradé — même logique de chaînage
 * dans les deux cas (voir `append`/`verifyChain`). Signature de `append`
 * inchangée pour les appelants déjà écrits contre l'ancienne version en
 * mémoire (aucun module n'appelait encore `append` avant ce sprint — voir
 * HANDOFF.md) ; devenue asynchrone (persistance), ce qui est compatible
 * avec tout futur appelant qui l'attend déjà avec `await`.
 */
@Injectable()
export class LedgerService implements OnModuleInit {
  constructor(@InjectRepository(LedgerEntry) private readonly repo: EntityRepository<LedgerEntry>) {}

  /** Seed idempotent — uniquement si la table (ou le repli mémoire) est vide, pour ne pas dupliquer à chaque redémarrage. */
  async onModuleInit(): Promise<void> {
    await withDegradedFallback(
      'LedgerService.seed',
      async () => {
        const count = await this.repo.count();
        if (count > 0) return;
        let prevHash = GENESIS_HASH;
        for (const [i, s] of SEED_DATA.entries()) {
          const at = new Date(Date.UTC(2026, 0, 1, i));
          const id = randomUUID();
          const base = { id, type: s.type, ref: s.ref, actor: s.actor, summary: s.summary, at: at.toISOString(), prevHash };
          const hash = computeHash(base);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const entity = this.repo.create({ id, type: s.type, ref: s.ref, actor: s.actor, summary: s.summary, at, prevHash, hash } as any);
          this.repo.getEntityManager().persist(entity);
          prevHash = hash;
        }
        await this.repo.getEntityManager().flush();
      },
      () => {
        if (MEMORY_ENTRIES.length > 0) return;
        let prevHash = GENESIS_HASH;
        for (const [i, s] of SEED_DATA.entries()) {
          const at = new Date(Date.UTC(2026, 0, 1, i)).toISOString();
          const id = randomUUID();
          const base = { id, type: s.type, ref: s.ref, actor: s.actor, summary: s.summary, at, prevHash };
          const hash = computeHash(base);
          MEMORY_ENTRIES.push({ ...base, hash });
          prevHash = hash;
        }
      },
    );
  }

  async append(type: string, ref: string, actor: string, summary: string): Promise<LedgerEntryDto> {
    return withDegradedFallback(
      'LedgerService.append',
      async () => {
        const last = await this.repo.findOne({}, { orderBy: { seq: 'DESC' } });
        const prevHash = last?.hash ?? GENESIS_HASH;
        const id = randomUUID();
        const at = new Date();
        const base = { id, type, ref, actor, summary, at: at.toISOString(), prevHash };
        const hash = computeHash(base);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entity = this.repo.create({ id, type, ref, actor, summary, at, prevHash, hash } as any);
        await this.repo.getEntityManager().persistAndFlush(entity);
        return toDto(entity);
      },
      () => {
        const prevHash = MEMORY_ENTRIES.length ? MEMORY_ENTRIES[MEMORY_ENTRIES.length - 1].hash : GENESIS_HASH;
        const id = randomUUID();
        const at = new Date().toISOString();
        const base = { id, type, ref, actor, summary, at, prevHash };
        const hash = computeHash(base);
        const entry: LedgerEntryDto = { ...base, hash };
        MEMORY_ENTRIES.push(entry);
        return entry;
      },
    );
  }

  async list(from?: string, to?: string): Promise<LedgerEntryDto[]> {
    return withDegradedFallback(
      'LedgerService.list',
      async () => {
        const rows = await this.repo.findAll({ orderBy: { seq: 'ASC' } });
        return rows.map(toDto).filter((e) => (!from || e.at >= from) && (!to || e.at <= to));
      },
      () => MEMORY_ENTRIES.filter((e) => (!from || e.at >= from) && (!to || e.at <= to)),
    );
  }

  /** Vérifie l'intégrité du chaînage (recalcule chaque hash). Utilisé par l'export / l'audit. */
  async verifyChain(): Promise<{ valid: boolean; brokenAt?: string }> {
    const entries = await withDegradedFallback(
      'LedgerService.verifyChain',
      async () => (await this.repo.findAll({ orderBy: { seq: 'ASC' } })).map(toDto),
      () => MEMORY_ENTRIES,
    );

    let prevHash: string | null = null;
    for (const e of entries) {
      const expectedPrev = prevHash ?? GENESIS_HASH;
      if (e.prevHash !== expectedPrev) return { valid: false, brokenAt: e.id };
      const recomputed = computeHash({ id: e.id, type: e.type, ref: e.ref, actor: e.actor, summary: e.summary, at: e.at, prevHash: e.prevHash ?? GENESIS_HASH });
      if (recomputed !== e.hash) return { valid: false, brokenAt: e.id };
      prevHash = e.hash;
    }
    return { valid: true };
  }
}
