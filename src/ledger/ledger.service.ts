import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { getLedgerHmacKey, isProductionEnv } from '../common/config/env.validation';
import { DEFAULT_PAGE_SIZE, paginateArray, PaginatedResult } from '../common/dto/pagination.dto';
import { withDegradedFallback } from '../common/interfaces/degraded-mode';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerHead } from './entities/ledger-head.entity';

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

export interface LedgerVerification {
  valid: boolean;
  /** Code de l'anomalie : EMPTY, BROKEN_LINK, HASH_MISMATCH, HEAD_MISSING, HEAD_MISMATCH, HEAD_MAC_INVALID. */
  reason?: string;
  /** Entrée où la chaîne est rompue (si applicable). */
  brokenAt?: string;
  /** Nombre d'entrées vérifiées. */
  entries: number;
  /** Entrées antérieures à SEC-15 (empreinte v1 sans secret). */
  legacyEntries: number;
  /** Empreinte de tête : à ancrer périodiquement HORS base (exploitation). */
  headHash: string | null;
  checkedAt: string;
}

export interface LedgerListQuery {
  page?: number;
  pageSize?: number;
  from?: string;
  to?: string;
}

export const GENESIS_HASH = '0'.repeat(64);

/** Verrou consultatif transactionnel qui sérialise les ajouts (SEC-15). */
const LEDGER_ADVISORY_LOCK_SQL = "select pg_advisory_xact_lock(hashtext('ida_place.ledger_entry'))";
const VERIFY_BATCH_SIZE = 1000;
/** SEC-16 — résultat de vérification mis en cache (invalidé à chaque ajout). */
export const VERIFY_CACHE_TTL_MS = 30_000;
/** Bornes alignées sur les colonnes (`varchar(255)`, `text` borné applicativement). */
const MAX_FIELD_LENGTH = 255;
const MAX_SUMMARY_LENGTH = 4000;

interface ChainFields {
  id: string;
  type: string;
  ref: string;
  actor: string;
  summary: string;
  at: string;
  prevHash: string;
}

/** v1 (historique, AVANT SEC-15) : SHA-256 sans secret d'une concaténation `|` ambiguë. Vérification seulement. */
export function computeLegacyHash(e: ChainFields): string {
  return createHash('sha256').update(`${e.id}|${e.type}|${e.ref}|${e.actor}|${e.summary}|${e.at}|${e.prevHash}`).digest('hex');
}

/**
 * v2 (SEC-15) : HMAC-SHA256 (clé hors base) d'un encodage CANONIQUE — un
 * tableau JSON à positions fixes, dont l'échappement des chaînes rend les
 * frontières de champs non ambiguës (un `|` ou un `"` dans `summary` ne
 * peut plus déplacer du texte d'un champ à l'autre).
 */
export function computeEntryMac(key: string, e: ChainFields): string {
  return createHmac('sha256', key)
    .update(JSON.stringify(['IDA-PLACE-LEDGER', 2, e.id, e.type, e.ref, e.actor, e.summary, e.at, e.prevHash]))
    .digest('hex');
}

export function computeHeadMac(key: string, entryCount: number, headHash: string): string {
  return createHmac('sha256', key).update(JSON.stringify(['IDA-PLACE-LEDGER-HEAD', 2, entryCount, headHash])).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

interface StoredEntry extends ChainFields {
  hash: string;
  hashVersion: number;
}

interface StoredHead {
  entryCount: number;
  headHash: string;
  mac: string;
}

const SEED_DATA = [
  { type: 'SYSTEM', ref: 'BOOT', actor: 'system', summary: 'Initialisation du journal scellé (démonstration, hors production)' },
  { type: 'CLAIM', ref: 'clm-1000', actor: 'import@caat.dz', summary: 'Dossier ingéré via import 47 colonnes' },
  { type: 'MATCH', ref: 'mtc-2000', actor: 'operateur@finlab.dz', summary: 'Confrontation confirmée manuellement' },
];

/** Repli mémoire — mode dégradé de DÉVELOPPEMENT uniquement (jamais en production, SEC-15). */
const MEMORY_ENTRIES: StoredEntry[] = [];
let MEMORY_HEAD: StoredHead | null = null;

function toDto(e: { id: string; type: string; ref: string; actor: string; summary: string; at: Date | string; prevHash: string; hash: string }): LedgerEntryDto {
  return {
    id: e.id,
    type: e.type,
    ref: e.ref,
    actor: e.actor,
    summary: e.summary,
    at: typeof e.at === 'string' ? e.at : e.at.toISOString(),
    prevHash: e.prevHash,
    hash: e.hash,
  };
}

function toStored(e: LedgerEntry): StoredEntry {
  return { id: e.id, type: e.type, ref: e.ref, actor: e.actor, summary: e.summary, at: e.at.toISOString(), prevHash: e.prevHash, hash: e.hash, hashVersion: e.hashVersion };
}

function assertField(name: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new BadRequestException({ code: 'BAD_REQUEST', message: `Journal scellé : champ "${name}" obligatoire (${max} caractères au plus).` });
  }
  return value;
}

/**
 * Vérificateur incrémental de chaîne (partagé base / mémoire).
 */
class ChainVerifier {
  private prevHash = GENESIS_HASH;
  count = 0;
  legacy = 0;
  failure?: { reason: string; brokenAt: string };

  constructor(private readonly key: string) {}

  feed(e: StoredEntry): boolean {
    if (this.failure) return false;
    if (e.prevHash !== this.prevHash) {
      this.failure = { reason: 'BROKEN_LINK', brokenAt: e.id };
      return false;
    }
    const fields: ChainFields = { id: e.id, type: e.type, ref: e.ref, actor: e.actor, summary: e.summary, at: e.at, prevHash: e.prevHash };
    const expected = e.hashVersion === 1 ? computeLegacyHash(fields) : e.hashVersion === 2 ? computeEntryMac(this.key, fields) : null;
    if (!expected || !safeEqualHex(expected, e.hash)) {
      this.failure = { reason: 'HASH_MISMATCH', brokenAt: e.id };
      return false;
    }
    if (e.hashVersion === 1) this.legacy++;
    this.count++;
    this.prevHash = e.hash;
    return true;
  }

  finish(head: StoredHead | null): LedgerVerification {
    const base = { entries: this.count, legacyEntries: this.legacy, headHash: this.count > 0 ? this.prevHash : null, checkedAt: new Date().toISOString() };
    if (this.failure) return { valid: false, ...this.failure, ...base };
    if (this.count === 0) {
      // SEC-15 : une table vide n'est jamais « valide » (vidée, ou jamais initialisée).
      return { valid: false, reason: 'EMPTY', ...base };
    }
    if (!head) {
      // Ancre absente : acceptable uniquement pour un journal 100 % historique (avant toute écriture v2).
      return this.legacy === this.count ? { valid: true, reason: 'LEGACY_UNANCHORED', ...base } : { valid: false, reason: 'HEAD_MISSING', ...base };
    }
    if (!safeEqualHex(computeHeadMac(this.key, head.entryCount, head.headHash), head.mac)) {
      return { valid: false, reason: 'HEAD_MAC_INVALID', ...base };
    }
    if (head.entryCount !== this.count || head.headHash !== this.prevHash) {
      // Entrées supprimées en fin de chaîne (troncature) ou ajoutées hors application.
      return { valid: false, reason: 'HEAD_MISMATCH', ...base };
    }
    return { valid: true, ...base };
  }
}

/**
 * LedgerModule — écran 13 "Journal scellé", B.2/B.3.
 *
 * SEC-15 (revue sécurité 2026-10-19) :
 *  - empreinte v2 = HMAC-SHA256 (`LEDGER_HMAC_KEY`, hors base, obligatoire en
 *    production) d'un encodage canonique ; les entrées v1 existantes restent
 *    vérifiées avec l'ancien algorithme (`legacyEntries`) ;
 *  - `append` sérialisé : transaction + `pg_advisory_xact_lock`, plus
 *    `UNIQUE(prev_hash)` en base — 100 ajouts concurrents donnent une chaîne
 *    linéaire ; si l'appelant est déjà dans une transaction MikroORM, l'ajout
 *    y participe (même transaction que l'écriture métier) ;
 *  - ancre de tête (`ledger_head`, HMAC) mise à jour à chaque ajout :
 *    détection d'une table vidée ou tronquée ;
 *  - plus aucun repli mémoire en production : `append`/`list`/`verifyChain`
 *    répondent 503 si la base est injoignable (le repli mémoire reste en
 *    développement/test, où les suites e2e tournent sans PostgreSQL) ;
 *  - aucune entrée de démonstration en production.
 *
 * Signature publique de `append(type, ref, actor, summary)` inchangée.
 */
@Injectable()
export class LedgerService implements OnModuleInit {
  private readonly logger = new Logger('LedgerService');
  private verifyCache?: { at: number; result: LedgerVerification };

  constructor(@InjectRepository(LedgerEntry) private readonly repo: EntityRepository<LedgerEntry>) {}

  private get em(): EntityManager {
    return this.repo.getEntityManager() as EntityManager;
  }

  private get key(): string {
    return getLedgerHmacKey().key;
  }

  /** Seed de DÉMONSTRATION idempotent, hors production uniquement (SEC-15). */
  async onModuleInit(): Promise<void> {
    if (isProductionEnv()) return;
    if (getLedgerHmacKey().ephemeral) {
      this.logger.warn('LEDGER_HMAC_KEY absent : clé éphémère — les entrées persistées ne seront plus vérifiables après redémarrage.');
    }
    await withDegradedFallback(
      'LedgerService.seed',
      async () => {
        const em = this.em.fork();
        if ((await em.count(LedgerEntry)) > 0) return;
        for (const s of SEED_DATA) await this.appendInDatabase(em, s.type, s.ref, s.actor, s.summary);
      },
      () => {
        if (MEMORY_ENTRIES.length > 0) return;
        for (const s of SEED_DATA) this.appendInMemory(s.type, s.ref, s.actor, s.summary);
      },
    );
  }

  async append(type: string, ref: string, actor: string, summary: string): Promise<LedgerEntryDto> {
    assertField('type', type, MAX_FIELD_LENGTH);
    assertField('ref', ref, MAX_FIELD_LENGTH);
    assertField('actor', actor, MAX_FIELD_LENGTH);
    assertField('summary', summary, MAX_SUMMARY_LENGTH);
    const entry = await withDegradedFallback(
      'LedgerService.append',
      () => this.appendInDatabase(this.em, type, ref, actor, summary),
      () => this.appendInMemory(type, ref, actor, summary),
    );
    this.verifyCache = undefined;
    return entry;
  }

  private async appendInDatabase(em: EntityManager, type: string, ref: string, actor: string, summary: string): Promise<LedgerEntryDto> {
    const key = this.key;
    return em.transactional(async (tem) => {
      await tem.execute(LEDGER_ADVISORY_LOCK_SQL);
      // NB :  est refusé par MikroORM 6 (« empty where ») — l'ancienne version levait donc
      // toujours ici, erreur masquée par le repli mémoire : aucune entrée n'était réellement persistée.
      const [last] = await tem.find(LedgerEntry, {}, { orderBy: { seq: 'DESC' }, limit: 1 });
      const prevHash = last?.hash ?? GENESIS_HASH;
      const id = randomUUID();
      const at = new Date();
      const hash = computeEntryMac(key, { id, type, ref, actor, summary, at: at.toISOString(), prevHash });
      const entity = tem.create(LedgerEntry, { id, type, ref, actor, summary, at, prevHash, hash, hashVersion: 2 });
      tem.persist(entity);
      await tem.flush();

      const head = await tem.findOne(LedgerHead, { id: 1 });
      const entryCount = head ? head.entryCount + 1 : await tem.count(LedgerEntry);
      const mac = computeHeadMac(key, entryCount, hash);
      if (head) {
        Object.assign(head, { entryCount, headSeq: entity.seq, headHash: hash, mac, updatedAt: new Date() });
      } else {
        tem.persist(tem.create(LedgerHead, { id: 1, entryCount, headSeq: entity.seq, headHash: hash, mac, updatedAt: new Date() }));
      }
      await tem.flush();
      return toDto(entity);
    });
  }

  private appendInMemory(type: string, ref: string, actor: string, summary: string): LedgerEntryDto {
    const key = this.key;
    const prevHash = MEMORY_ENTRIES.length ? MEMORY_ENTRIES[MEMORY_ENTRIES.length - 1].hash : GENESIS_HASH;
    const fields: ChainFields = { id: randomUUID(), type, ref, actor, summary, at: new Date().toISOString(), prevHash };
    const entry: StoredEntry = { ...fields, hash: computeEntryMac(key, fields), hashVersion: 2 };
    MEMORY_ENTRIES.push(entry);
    MEMORY_HEAD = { entryCount: MEMORY_ENTRIES.length, headHash: entry.hash, mac: computeHeadMac(key, MEMORY_ENTRIES.length, entry.hash) };
    return toDto(entry);
  }

  /** SEC-16 — lecture paginée, filtrée en SQL (`from`/`to` déjà validés ISO 8601 par le DTO). */
  async list(query: LedgerListQuery = {}): Promise<PaginatedResult<LedgerEntryDto>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    return withDegradedFallback(
      'LedgerService.list',
      async () => {
        const where = from || to ? { at: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {};
        const [rows, total] = await this.em.fork().findAndCount(LedgerEntry, where, { orderBy: { seq: 'ASC' }, limit: pageSize, offset: (page - 1) * pageSize });
        return new PaginatedResult(rows.map(toDto), total, page);
      },
      () => {
        const filtered = MEMORY_ENTRIES.filter((e) => (!from || new Date(e.at) >= from) && (!to || new Date(e.at) <= to)).map(toDto);
        return paginateArray(filtered, page, pageSize);
      },
    );
  }

  /**
   * Vérifie l'intégrité de la chaîne (recalcul de chaque empreinte, lecture
   * par lots) et sa cohérence avec l'ancre de tête. Jamais `valid: true` si
   * la base est injoignable (503 en production) ou la table vide/tronquée.
   * Résultat mis en cache `VERIFY_CACHE_TTL_MS` (invalidé à chaque ajout).
   */
  async verifyChain(): Promise<LedgerVerification> {
    if (this.verifyCache && Date.now() - this.verifyCache.at < VERIFY_CACHE_TTL_MS) return this.verifyCache.result;
    const key = this.key;
    const result = await withDegradedFallback(
      'LedgerService.verifyChain',
      async () => {
        const verifier = new ChainVerifier(key);
        const em = this.em.fork();
        let lastSeq = 0;
        for (;;) {
          const batch = await em.find(LedgerEntry, { seq: { $gt: lastSeq } }, { orderBy: { seq: 'ASC' }, limit: VERIFY_BATCH_SIZE });
          for (const e of batch) if (!verifier.feed(toStored(e))) break;
          if (verifier.failure || batch.length < VERIFY_BATCH_SIZE) break;
          lastSeq = batch[batch.length - 1].seq;
          em.clear();
        }
        const head = await em.findOne(LedgerHead, { id: 1 });
        return verifier.finish(head ? { entryCount: head.entryCount, headHash: head.headHash, mac: head.mac } : null);
      },
      () => {
        const verifier = new ChainVerifier(key);
        for (const e of MEMORY_ENTRIES) if (!verifier.feed(e)) break;
        return verifier.finish(MEMORY_HEAD);
      },
    );
    if (!result.valid) this.logger.error(`Journal scellé NON VALIDE : ${result.reason}${result.brokenAt ? ` (entrée ${result.brokenAt})` : ''}`);
    this.verifyCache = { at: Date.now(), result };
    return result;
  }
}

/** Accès de test au repli mémoire (simulation d'altérations) — ne pas utiliser en code applicatif. */
export const __ledgerMemoryForTests = {
  entries: MEMORY_ENTRIES,
  get head(): StoredHead | null {
    return MEMORY_HEAD;
  },
  set head(value: StoredHead | null) {
    MEMORY_HEAD = value;
  },
  reset(): void {
    MEMORY_ENTRIES.length = 0;
    MEMORY_HEAD = null;
  },
};
