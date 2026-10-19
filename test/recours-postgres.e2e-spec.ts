import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { AuthenticatedUser } from '../src/common/interfaces/authenticated-user.interface';

/**
 * Intégration sur un VRAI PostgreSQL (SEC-19, SEC-20, SEC-33, SEC-34, SEC-47,
 * SEC-49) — les garanties d'unicité, de verrouillage et de contraintes vivent
 * en base et ne sont pas observables en mode dégradé.
 *
 * Ignoré par défaut. Pour l'exécuter contre une base migrée :
 *   IDA_TEST_PG_PORT=55432 npx jest --config test/jest-e2e.json test/recours-postgres
 * (base `ida_place`, utilisateur `ida_place`, migrations appliquées par
 * `DB_PORT=55432 npx mikro-orm migration:up`).
 */
const PG_PORT = process.env.IDA_TEST_PG_PORT;
const describeIfPg = PG_PORT ? describe : describe.skip;

const place = (id = 'op-pg'): AuthenticatedUser => ({ id, name: id, email: `${id}@test.dz`, role: 'OPERATEUR_PLACE', privileges: [] });
const corr = (companyId: string): AuthenticatedUser => ({ id: `corr-${companyId}`, name: `corr-${companyId}`, email: 'c@test.dz', role: 'CORRESPONDANT_IDA', companyId, privileges: ['exchange'] });
const member = (id: string): AuthenticatedUser => ({ id, name: id, email: `${id}@test.dz`, role: 'MEMBRE_COMMISSION', privileges: [] });

describeIfPg('Intégration PostgreSQL réelle — recours, clôtures, commission, adhésions', () => {
  jest.setTimeout(60_000);
  let app: INestApplication;
  // Chargés après la configuration de la base (la configuration MikroORM est lue à l'import).
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let recours: any;
  let settlement: any;
  let commission: any;
  let membership: any;
  let adherents: any;
  let experts: any;
  let sql: (query: string, params?: unknown[]) => Promise<any[]>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    process.env.DB_PORT = PG_PORT;
    process.env.DB_HOST = process.env.DB_HOST ?? 'localhost';
    const { createTestApp } = await import('./utils/test-app');
    const { RecoursService } = await import('../src/recours/recours.service');
    const { SettlementService } = await import('../src/settlement/settlement.service');
    const { CommissionService } = await import('../src/commission/commission.service');
    const { MembershipService } = await import('../src/commission/membership.service');
    const { AdherentsService } = await import('../src/adherents/adherents.service');
    const { ExpertsService } = await import('../src/experts/experts.service');
    const { MikroORM } = await import('@mikro-orm/core');
    app = await createTestApp();
    recours = app.get(RecoursService);
    settlement = app.get(SettlementService);
    commission = app.get(CommissionService);
    membership = app.get(MembershipService);
    adherents = app.get(AdherentsService);
    experts = app.get(ExpertsService);
    const orm = app.get(MikroORM);
    sql = (query, params = []) => orm.em.fork().getConnection().execute(query, params);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  it('SEC-20 : deux ouvertures concurrentes sur le même dossier — une seule ligne en base, l’autre 409', async () => {
    const claimId = `pg-${run}-20`;
    const results = await Promise.allSettled([1, 2, 3].map(() => recours.create({ claimId, from: 'CAAT', to: 'SAA', amount: 1000 }, place())));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) expect(r.reason.getStatus()).toBe(409);
    const rows = await sql('select count(*)::int as n from recours where claim_id = ?', [claimId]);
    expect(rows[0].n).toBe(1);
  });

  it('SEC-34 : montant en numeric(18,2), relu exactement', async () => {
    const created = await recours.create({ claimId: `pg-${run}-34`, from: 'CAAT', to: 'SAA', amount: 1234.56 }, place());
    const [row] = await sql('select amount::text as amount, pg_typeof(amount)::text as type from recours where id = ?', [created.id]);
    expect(row).toEqual({ amount: '1234.56', type: 'numeric' });
    expect((await recours.get(created.id)).amount).toBe(1234.56);
  });

  it('SEC-33 / SEC-17 : transitions concurrentes sous verrou — une seule réussit ; version, historique et journal cohérents', async () => {
    const created = await recours.create({ claimId: `pg-${run}-33`, from: 'CAAT', to: 'SAA', amount: 500 }, place());
    const results = await Promise.allSettled([
      recours.transition(created.id, { action: 'accepter' }, corr('SAA')),
      recours.transition(created.id, { action: 'opposer' }, corr('SAA')),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ state: string }>[];
    expect(ok).toHaveLength(1);
    const [row] = await sql('select state, version, jsonb_array_length(history) as n from recours where id = ?', [created.id]);
    expect(row.state).toBe(ok[0].value.state);
    expect(row.version).toBe(2);
    expect(row.n).toBe(2);
    const [last] = await sql("select h->>'actorId' as actor, h->>'onBehalfOf' as company from recours, jsonb_array_elements(history) h where id = ? and h->>'action' <> 'creation'", [created.id]);
    expect(last).toEqual({ actor: 'corr-SAA', company: 'SAA' });
    // NB : le scellement au journal est bien appelé dans la transaction, mais `LedgerService.append`
    // (périmètre « socle ») retombe aujourd'hui en mémoire même base disponible (`findOne({})`
    // refusé par MikroORM 6) — signalé au Tech Lead ; l'assertion sur `ledger_entry` sera ajoutée
    // une fois l'implémentation durcie fusionnée.
  });

  it('SEC-19 : deux clôtures concurrentes du même trimestre — une seule, instantané haché en base', async () => {
    const quarter = `20${10 + (parseInt(run.slice(0, 2), 16) % 10)}-Q${1 + (parseInt(run.slice(2, 3), 16) % 4)}`;
    await sql('delete from settlement_closure where scope = ? and period = ?', ['QUARTERLY', quarter]);
    const results = await Promise.allSettled([settlement.closeQuarterly(quarter, place('a')), settlement.closeQuarterly(quarter, place('b'))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await sql('select snapshot_hash, closed_by_id from settlement_closure where scope = ? and period = ?', ['QUARTERLY', quarter]);
    expect(rows).toHaveLength(1);
    expect(rows[0].snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('SEC-20 / SEC-32 : un seul dossier de commission par recours, même sous requêtes concurrentes', async () => {
    const created = await recours.create({ claimId: `pg-${run}-32`, from: 'CAAT', to: 'SAA', amount: 700 }, place());
    await recours.transition(created.id, { action: 'opposer' }, corr('SAA'));
    await recours.transition(created.id, { action: 'contester' }, corr('CAAT'));
    await recours.transition(created.id, { action: 'transmettre_commission' }, corr('CAAT'));
    const results = await Promise.allSettled([1, 2].map(() => commission.createCase({ recoursId: created.id, motif: 'x' }, member('m1'))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const kase = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>).value;
    await commission.deliberate(kase.id, member('m1'));
    await commission.decide(kase.id, { outcome: 'RECOURS_FONDE' }, member('m1'));
    await commission.pvSign(kase.id, member('m2'));
    await expect(commission.pvSign(kase.id, member('m3'))).rejects.toMatchObject({ status: 409 });
    const closed = await recours.transition(created.id, { action: 'cloturer_commission_favorable' }, member('m1'));
    expect(closed.state).toBe('REGLE');
  });

  it('SEC-20 / SEC-47 : une seule demande de retrait reçue par compagnie (index unique partiel)', async () => {
    const code = `R${run.slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
    const company = await adherents.createCompany({ code, name: 'PG', color: '#445566', kind: 'INSURER', feedMode: 'API' });
    const receivedAt = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const results = await Promise.allSettled([1, 2].map(() => membership.create({ type: 'RETRAIT', receivedAt, companyId: company.id, letterRef: 'L' }, place())));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.getStatus()).toBe(409);
  });

  it('SEC-49 : la base refuse un montant nul et une population à 0', async () => {
    await expect(sql(`insert into recours (id, claim_id, "from", "to", amount) values (?, ?, 'CAAT', 'SAA', 0)`, [randomUUID(), `pg-${run}-49`])).rejects.toThrow(/recours_amount_check/);
    await expect(sql(`insert into wilaya_population (id, wilaya_code, reference_year, population, source_type, source_ref, created_by) values (?, '16', 2024, 0, 'AUTRE', 'x', 'u')`, [randomUUID()])).rejects.toThrow(/wilaya_population_population_check/);
  });

  it('SEC-26 : filtrage des experts par compagnie en SQL (opérateur tableau)', async () => {
    const shared = await experts.create({ name: `Expert ${run} partagé`, companies: ['CAAT', 'SAA'] }, place());
    const other = await experts.create({ name: `Expert ${run} CASH`, companies: ['CASH'] }, place());
    const forCaat = await experts.list(1, 100, corr('CAAT'));
    const ids = forCaat.items.map((e: { id: string }) => e.id);
    expect(ids).toContain(shared.id);
    expect(ids).not.toContain(other.id);
    expect(forCaat.items.find((e: { id: string }) => e.id === shared.id).companies).toEqual(['CAAT']);
  });
});
