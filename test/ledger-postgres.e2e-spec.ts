import { randomUUID } from 'crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { LedgerEntry } from '../src/ledger/entities/ledger-entry.entity';
import { LedgerHead } from '../src/ledger/entities/ledger-head.entity';
import { computeLegacyHash, GENESIS_HASH, LedgerService } from '../src/ledger/ledger.service';

/**
 * SEC-15 — test d'intégration du journal scellé contre un PostgreSQL RÉEL
 * (concurrence, altération, troncature, triggers, compatibilité v1).
 *
 * Ignoré si `LEDGER_IT_DB_PORT` n'est pas défini (la suite e2e standard tourne
 * sans base). Exemple :
 *   docker run -d --name ida-ledger-it -e POSTGRES_DB=ida_place_it -e POSTGRES_USER=ida_place_it \
 *     -e POSTGRES_PASSWORD=it-pass -p 127.0.0.1:55433:5432 postgres:16-alpine
 *   LEDGER_IT_DB_PORT=55433 LEDGER_IT_DB_PASSWORD=it-pass npx jest --config test/jest-e2e.json test/ledger-postgres
 * La base indiquée est REMISE À ZÉRO (schéma public supprimé) : n'utiliser
 * qu'une base jetable.
 */
const enabled = !!process.env.LEDGER_IT_DB_PORT;
const describeIfDb = enabled ? describe : describe.skip;

describeIfDb('Journal scellé — PostgreSQL réel (SEC-15)', () => {
  let orm: MikroORM;
  let service: LedgerService;
  const originalKey = process.env.LEDGER_HMAC_KEY;

  const sql = (query: string, params: unknown[] = []) => orm.em.getConnection().execute(query, params);
  /** Simule un administrateur de base (propriétaire) qui contourne les triggers, sans la clé HMAC. */
  const asDba = async (query: string, params: unknown[] = []) => {
    await sql('alter table "ledger_entry" disable trigger user');
    try {
      return await sql(query, params);
    } finally {
      await sql('alter table "ledger_entry" enable trigger user');
    }
  };
  const freshService = () => new LedgerService(orm.em.getRepository(LedgerEntry));

  beforeAll(async () => {
    process.env.LEDGER_HMAC_KEY = 'cle-hmac-de-test-integration-ledger-0123456789';
    orm = await MikroORM.init({
      entities: [LedgerEntry, LedgerHead],
      host: process.env.LEDGER_IT_DB_HOST ?? '127.0.0.1',
      port: Number(process.env.LEDGER_IT_DB_PORT),
      dbName: process.env.LEDGER_IT_DB_NAME ?? 'ida_place_it',
      user: process.env.LEDGER_IT_DB_USER ?? 'ida_place_it',
      password: process.env.LEDGER_IT_DB_PASSWORD ?? 'it-socle-pass',
      extensions: [Migrator],
      migrations: { pathTs: 'src/migrations', path: 'src/migrations', glob: '!(*.d).{js,ts}', transactional: true, snapshot: false },
      pool: { min: 1, max: 20 },
    });
    await sql('drop schema public cascade');
    await sql('create schema public');
    // Schéma AVANT SEC-15 : seule la migration historique du journal.
    await orm.getMigrator().up({ migrations: ['Migration20260301000001_Ledger'] });
    service = freshService();
  }, 60_000);

  afterAll(async () => {
    process.env.LEDGER_HMAC_KEY = originalKey;
    await orm?.close(true);
  });

  it('compatibilité : des entrées v1 existantes restent vérifiables après la migration SEC-15', async () => {
    let prevHash = GENESIS_HASH;
    for (let i = 0; i < 2; i++) {
      const at = new Date(Date.UTC(2026, 0, 1, i));
      const fields = { id: randomUUID(), type: 'SYSTEM', ref: `L${i}`, actor: 'system', summary: `historique ${i}`, at: at.toISOString(), prevHash };
      const hash = computeLegacyHash(fields);
      await sql('insert into "ledger_entry" ("id","type","ref","actor","summary","at","prev_hash","hash") values (?,?,?,?,?,?,?,?)', [
        fields.id, fields.type, fields.ref, fields.actor, fields.summary, at, prevHash, hash,
      ]);
      prevHash = hash;
    }
    await orm.getMigrator().up({ migrations: ['Migration20261020000100_LedgerIntegrity'] });

    expect(await freshService().verifyChain()).toMatchObject({ valid: true, reason: 'LEGACY_UNANCHORED', entries: 2, legacyEntries: 2 });
    await service.append('GOUVERNANCE', 'migration', 'system', 'Première entrée v2 (HMAC)');
    expect(await freshService().verifyChain()).toMatchObject({ valid: true, entries: 3, legacyEntries: 2 });
  }, 60_000);

  it('100 ajouts concurrents donnent une chaîne linéaire valide', async () => {
    await Promise.all(Array.from({ length: 100 }, (_, i) => service.append('RECOURS', `rec-${i}`, 'op@finlab.dz', `Transition ${i}`)));
    const result = await freshService().verifyChain();
    expect(result).toMatchObject({ valid: true, entries: 103 });
    const [{ forks }] = await sql('select count(*)::int - count(distinct prev_hash)::int as forks from "ledger_entry"');
    expect(forks).toBe(0);
    const [head] = await sql('select entry_count, head_hash from "ledger_head"');
    expect(head.entry_count).toBe(103);
    expect(head.head_hash).toBe(result.headHash);
  }, 120_000);

  it('UPDATE, DELETE et TRUNCATE sont refusés par la base (trigger)', async () => {
    await expect(sql('update "ledger_entry" set "summary" = ? where "seq" = (select min(seq) from "ledger_entry")', ['falsifié'])).rejects.toThrow(/journal scellé/);
    await expect(sql('delete from "ledger_entry" where "seq" = (select max(seq) from "ledger_entry")')).rejects.toThrow(/journal scellé/);
    await expect(sql('truncate "ledger_entry"')).rejects.toThrow(/journal scellé/);
    await expect(sql('delete from "ledger_head"')).rejects.toThrow(/journal scellé/);
  });

  it('une fourche (deux entrées sur le même prev_hash) est refusée : UNIQUE(prev_hash)', async () => {
    const [last] = await sql('select "prev_hash" from "ledger_entry" order by seq desc limit 1');
    await expect(
      sql('insert into "ledger_entry" ("id","type","ref","actor","summary","at","prev_hash","hash","hash_version") values (?,?,?,?,?,now(),?,?,2)', [
        randomUUID(), 'X', 'x', 'x', 'fourche', last.prev_hash, 'f'.repeat(64),
      ]),
    ).rejects.toThrow(/ledger_entry_prev_hash_unique|duplicate key/);
  });

  it('une modification directe en base (triggers contournés, sans la clé) est détectée', async () => {
    const [target] = await sql('select seq, summary from "ledger_entry" where hash_version = 2 order by seq limit 1 offset 10');
    await asDba('update "ledger_entry" set "summary" = ? where "seq" = ?', ['Pénalité annulée', target.seq]);
    expect(await freshService().verifyChain()).toMatchObject({ valid: false, reason: 'HASH_MISMATCH' });
    await asDba('update "ledger_entry" set "summary" = ? where "seq" = ?', [target.summary, target.seq]);
    expect((await freshService().verifyChain()).valid).toBe(true);
  });

  it('une troncature en fin de chaîne est détectée (ancre de tête)', async () => {
    const [last] = await sql('select * from "ledger_entry" order by seq desc limit 1');
    await asDba('delete from "ledger_entry" where "seq" = ?', [last.seq]);
    expect(await freshService().verifyChain()).toMatchObject({ valid: false, reason: 'HEAD_MISMATCH', entries: 102 });
    await asDba(
      'insert into "ledger_entry" ("seq","id","type","ref","actor","summary","at","prev_hash","hash","hash_version") values (?,?,?,?,?,?,?,?,?,?)',
      [last.seq, last.id, last.type, last.ref, last.actor, last.summary, last.at, last.prev_hash, last.hash, last.hash_version],
    );
    expect((await freshService().verifyChain()).valid).toBe(true);
  });

  it('une table vidée n’est jamais « valide »', async () => {
    await sql('alter table "ledger_entry" disable trigger user');
    try {
      await sql('create temporary table ledger_backup as select * from "ledger_entry"');
      await sql('delete from "ledger_entry"');
      expect(await freshService().verifyChain()).toMatchObject({ valid: false, reason: 'EMPTY' });
      await sql('insert into "ledger_entry" select * from ledger_backup');
    } finally {
      await sql('alter table "ledger_entry" enable trigger user');
    }
    expect((await freshService().verifyChain()).valid).toBe(true);
  });
});
