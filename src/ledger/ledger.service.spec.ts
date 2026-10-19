import { createHash } from 'crypto';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getLedgerHmacKey } from '../common/config/env.validation';
import { simulatedDatabaseOutage } from '../common/database/db-errors';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { __ledgerMemoryForTests as memory, computeEntryMac, computeHeadMac, computeLegacyHash, GENESIS_HASH, LedgerService } from './ledger.service';

/** Double de repository dont la base est injoignable (repli mémoire hors production). */
function unreachableRepo() {
  const outage = () => Promise.reject(simulatedDatabaseOutage());
  const em = {
    fork: () => em,
    count: jest.fn(outage),
    find: jest.fn(outage),
    findOne: jest.fn(outage),
    findAndCount: jest.fn(outage),
    transactional: jest.fn(outage),
    clear: jest.fn(),
  };
  return { getEntityManager: () => em };
}

async function buildService(): Promise<LedgerService> {
  const moduleRef = await Test.createTestingModule({
    providers: [LedgerService, { provide: getRepositoryToken(LedgerEntry), useFactory: unreachableRepo }],
  }).compile();
  return moduleRef.get(LedgerService);
}

/**
 * SEC-15 / SEC-16 — journal scellé. Ces tests exercent le repli mémoire de
 * développement (même algorithme que la base) ; le comportement réel sous
 * PostgreSQL (verrou, UNIQUE(prev_hash), triggers, 100 ajouts concurrents)
 * est couvert par `test/ledger-postgres.e2e-spec.ts` (base réelle requise).
 */
describe('LedgerService (SEC-15/SEC-16)', () => {
  const originalEnv = process.env.NODE_ENV;
  let service: LedgerService;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    memory.reset();
    service = await buildService();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('une chaîne construite par append est valide, ancrée, et la signature publique est inchangée', async () => {
    await service.append('RECOURS', 'rec-1', 'op@finlab.dz', 'Transition ACCEPTE');
    await service.append('SANCTION', 'san-1', 'commission@uar.dz', 'Pénalité de retard');
    const result = await service.verifyChain();
    expect(result).toMatchObject({ valid: true, entries: 2, legacyEntries: 0 });
    expect(result.headHash).toBe(memory.entries[1].hash);
  });

  it('les empreintes v2 sont des HMAC (clé hors base) : un SHA-256 recalculé sans la clé ne valide pas', async () => {
    const e = await service.append('T', 'r', 'a', 's');
    const fields = { id: e.id, type: e.type, ref: e.ref, actor: e.actor, summary: e.summary, at: e.at, prevHash: GENESIS_HASH };
    expect(e.hash).toBe(computeEntryMac(getLedgerHmacKey().key, fields));
    expect(e.hash).not.toBe(computeLegacyHash(fields));
    expect(computeEntryMac('autre-cle', fields)).not.toBe(e.hash);
  });

  it('détecte une modification directe d’une entrée (même avec recalcul SHA-256 de la chaîne sans la clé)', async () => {
    await service.append('SANCTION', 'san-1', 'commission@uar.dz', 'Pénalité 50 000 DA');
    await service.append('RECOURS', 'rec-2', 'op@finlab.dz', 'Clôture');
    memory.entries[0].summary = 'Pénalité 0 DA';
    memory.entries[0].hash = createHash('sha256').update('falsifié').digest('hex');
    expect(await (await buildService()).verifyChain()).toMatchObject({ valid: false, reason: 'HASH_MISMATCH', brokenAt: memory.entries[0].id });
  });

  it('encodage canonique : déplacer un "|" entre deux champs change l’empreinte', () => {
    const base = { id: 'i', type: 'T', ref: 'a|b', actor: 'x', summary: 's', at: '2026-01-01T00:00:00.000Z', prevHash: GENESIS_HASH };
    expect(computeLegacyHash({ ...base, ref: 'a|b', actor: 'x' })).toBe(computeLegacyHash({ ...base, ref: 'a', actor: 'b|x' })); // faille v1
    expect(computeEntryMac('k', { ...base, ref: 'a|b', actor: 'x' })).not.toBe(computeEntryMac('k', { ...base, ref: 'a', actor: 'b|x' })); // corrigé v2
  });

  it('détecte une troncature en fin de chaîne (ancre de tête)', async () => {
    for (let i = 0; i < 3; i++) await service.append('T', `r${i}`, 'a', `s${i}`);
    memory.entries.pop();
    expect(await (await buildService()).verifyChain()).toMatchObject({ valid: false, reason: 'HEAD_MISMATCH', entries: 2 });
  });

  it('une table vidée n’est jamais « valide »', async () => {
    await service.append('T', 'r', 'a', 's');
    memory.entries.length = 0;
    expect(await (await buildService()).verifyChain()).toMatchObject({ valid: false, reason: 'EMPTY' });
  });

  it('détecte une ancre de tête falsifiée (HMAC invalide)', async () => {
    await service.append('T', 'r', 'a', 's');
    memory.head = { ...memory.head!, entryCount: 99, mac: computeHeadMac('pas-la-cle', 99, memory.head!.headHash) };
    expect(await (await buildService()).verifyChain()).toMatchObject({ valid: false, reason: 'HEAD_MAC_INVALID' });
  });

  it('détecte une suppression au milieu de la chaîne (lien rompu)', async () => {
    for (let i = 0; i < 3; i++) await service.append('T', `r${i}`, 'a', `s${i}`);
    memory.entries.splice(1, 1);
    expect(await (await buildService()).verifyChain()).toMatchObject({ valid: false, reason: 'BROKEN_LINK' });
  });

  it('compatibilité : des entrées historiques v1 (sans ancre) restent vérifiables, puis protégées par la première entrée v2', async () => {
    let prevHash = GENESIS_HASH;
    for (let i = 0; i < 2; i++) {
      const fields = { id: `legacy-${i}`, type: 'SYSTEM', ref: `L${i}`, actor: 'system', summary: `ancienne ${i}`, at: new Date(Date.UTC(2026, 0, 1, i)).toISOString(), prevHash };
      const hash = computeLegacyHash(fields);
      memory.entries.push({ ...fields, hash, hashVersion: 1 });
      prevHash = hash;
    }
    expect(await (await buildService()).verifyChain()).toMatchObject({ valid: true, reason: 'LEGACY_UNANCHORED', legacyEntries: 2 });

    await service.append('T', 'r', 'a', 'première entrée v2');
    expect(await (await buildService()).verifyChain()).toMatchObject({ valid: true, entries: 3, legacyEntries: 2 });

    // Altération d'une entrée v1 avec recalcul complet de la chaîne v1 : la première entrée v2 (HMAC sur prev_hash) la détecte.
    memory.entries[0].summary = 'altérée';
    let ph = GENESIS_HASH;
    for (const e of memory.entries.slice(0, 2)) {
      e.prevHash = ph;
      e.hash = computeLegacyHash(e);
      ph = e.hash;
    }
    expect(await (await buildService()).verifyChain()).toMatchObject({ valid: false, reason: 'BROKEN_LINK', brokenAt: memory.entries[2].id });
  });

  it('valide les champs (400 si vide ou trop long)', async () => {
    await expect(service.append('', 'r', 'a', 's')).rejects.toMatchObject({ status: 400 });
    await expect(service.append('T', 'r', 'a', 'x'.repeat(4001))).rejects.toMatchObject({ status: 400 });
  });

  it('list : paginé et filtré par période', async () => {
    for (let i = 0; i < 8; i++) await service.append('T', `r${i}`, 'a', `s${i}`);
    const page = await service.list({ page: 2, pageSize: 3 });
    expect(page).toMatchObject({ page: 2, total: 8 });
    expect(page.items).toHaveLength(3);
    expect((await service.list({ from: '2999-01-01T00:00:00Z' })).total).toBe(0);
  });

  it('verifyChain met le résultat en cache et l’invalide à chaque ajout', async () => {
    await service.append('T', 'r', 'a', 's');
    const first = await service.verifyChain();
    expect(await service.verifyChain()).toBe(first);
    await service.append('T', 'r2', 'a', 's2');
    expect((await service.verifyChain()).entries).toBe(2);
  });

  describe('production : aucun repli mémoire (503)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      process.env.LEDGER_HMAC_KEY = 'k'.repeat(48);
    });

    afterEach(() => {
      delete process.env.LEDGER_HMAC_KEY;
    });

    it('append répond 503 si la base est injoignable', async () => {
      await expect(service.append('T', 'r', 'a', 's')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(memory.entries).toHaveLength(0);
    });

    it('verify répond 503 si la base est injoignable — jamais valid:true', async () => {
      await expect(service.verifyChain()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('aucune entrée de démonstration au démarrage', async () => {
      await service.onModuleInit();
      expect(memory.entries).toHaveLength(0);
    });
  });

  it('hors production : entrées de démonstration au démarrage (repli mémoire)', async () => {
    await service.onModuleInit();
    expect(memory.entries.length).toBeGreaterThan(0);
    expect((await service.verifyChain()).valid).toBe(true);
  });
});
