import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { AuthenticatedUser } from '../src/common/interfaces/authenticated-user.interface';

/**
 * Références métier sur un VRAI PostgreSQL (Migration20261021000000_ReferencesMetier) :
 * numérotation atomique sous concurrence, attribution par déclencheur,
 * immuabilité — garanties qui vivent en base et ne sont pas observables en
 * mode dégradé.
 *
 * Ignoré par défaut. Pour l'exécuter contre une base migrée DÉDIÉE aux tests
 * (jamais la base de développement : les tests y laissent des lignes) :
 *   IDA_TEST_PG_PORT=55432 npx jest --config test/jest-e2e.json test/business-ref-postgres
 */
const PG_PORT = process.env.IDA_TEST_PG_PORT;
const describeIfPg = PG_PORT ? describe : describe.skip;

const place = (id = 'op-ref'): AuthenticatedUser => ({ id, name: id, email: `${id}@test.dz`, role: 'OPERATEUR_PLACE', privileges: [] });
const corr = (companyId: string): AuthenticatedUser => ({ id: `corr-${companyId}`, name: `corr-${companyId}`, email: 'c@test.dz', role: 'CORRESPONDANT_IDA', companyId, privileges: ['exchange'] });
const member = (id: string): AuthenticatedUser => ({ id, name: id, email: `${id}@test.dz`, role: 'MEMBRE_COMMISSION', privileges: [] });

const numberOf = (ref: string) => Number(ref.split('-')[2]);

describeIfPg('Références métier — PostgreSQL réel', () => {
  jest.setTimeout(60_000);
  let app: INestApplication;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let recours: any;
  let commission: any;
  let sql: (query: string, params?: unknown[]) => Promise<any[]>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    process.env.DB_PORT = PG_PORT;
    process.env.DB_HOST = process.env.DB_HOST ?? 'localhost';
    const { createTestApp } = await import('./utils/test-app');
    const { RecoursService } = await import('../src/recours/recours.service');
    const { CommissionService } = await import('../src/commission/commission.service');
    const { MikroORM, RequestContext } = await import('@mikro-orm/core');
    app = await createTestApp();
    const orm = app.get(MikroORM);
    sql = (query, params = []) => orm.em.fork().getConnection().execute(query, params);
    const inRequest = <T extends object>(service: T): T =>
      new Proxy(service, {
        get: (target, prop) => {
          const value = (target as Record<string | symbol, unknown>)[prop];
          return typeof value === 'function' ? (...args: unknown[]) => RequestContext.create(orm.em, () => (value as (...a: unknown[]) => unknown).apply(target, args)) : value;
        },
      });
    recours = inRequest(app.get(RecoursService));
    commission = inRequest(app.get(CommissionService));
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  it('next_business_ref : 25 appels concurrents sur une même période donnent 25 numéros distincts et contigus', async () => {
    // Jour réservé au test (2099), tiré de l'identifiant d'exécution : n'interfère pas avec les périodes réelles.
    const day = new Date(Date.UTC(2099, parseInt(run.slice(0, 2), 16) % 12, 1 + (parseInt(run.slice(2, 4), 16) % 28), 10));
    const refs = (await Promise.all(Array.from({ length: 25 }, () => sql('select next_business_ref(?, ?) as ref', ['MAT', day.toISOString()])))).map((rows) => rows[0].ref as string);
    expect(new Set(refs).size).toBe(25);
    const numbers = refs.map(numberOf).sort((a, b) => a - b);
    expect(numbers[numbers.length - 1] - numbers[0]).toBe(24);
    for (const ref of refs) expect(ref).toMatch(/^MAT-99\d{4}-\d{3,}$/);
  });

  it('next_business_ref lit la période à l’heure d’Alger et refuse un type inconnu', async () => {
    const [{ ref }] = await sql('select next_business_ref(?, ?) as ref', ['MAT', '2098-12-31T23:30:00Z']);
    expect(ref).toMatch(/^MAT-990101-\d{3}$/);
    await expect(sql('select next_business_ref(?, ?) as ref', ['XYZ', '2098-01-01T00:00:00Z'])).rejects.toThrow(/inconnu/);
  });

  it('recours.create concurrents : références REC distinctes, contiguës, persistées telles que renvoyées', async () => {
    const created = await Promise.all(Array.from({ length: 8 }, (_, i) => recours.create({ claimId: `ref-${run}-${i}`, from: 'CAAT', to: 'SAA', amount: 1000 + i }, place())));
    const refs = created.map((r: { reference: string }) => r.reference);
    expect(new Set(refs).size).toBe(8);
    for (const ref of refs) expect(ref).toMatch(/^REC-\d{4}-\d{5,}$/);
    const numbers = refs.map(numberOf).sort((a: number, b: number) => a - b);
    expect(numbers[7] - numbers[0]).toBe(7);
    const rows = await sql('select id::text as id, reference from recours where claim_id like ?', [`ref-${run}-%`]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.reference]))).toEqual(Object.fromEntries(created.map((r: { id: string; reference: string }) => [r.id, r.reference])));
  });

  it('une création refusée (doublon, 409) ne consomme pas de numéro', async () => {
    const first = await recours.create({ claimId: `ref-${run}-dup`, from: 'CAAT', to: 'SAA', amount: 10 }, place());
    await expect(recours.create({ claimId: `ref-${run}-dup`, from: 'CAAT', to: 'SAA', amount: 10 }, place())).rejects.toMatchObject({ status: 409 });
    const next = await recours.create({ claimId: `ref-${run}-dup2`, from: 'CAAT', to: 'SAA', amount: 10 }, place());
    expect(numberOf(next.reference)).toBe(numberOf(first.reference) + 1);
  });

  it('déclencheurs : une insertion sans référence en reçoit une ; une référence posée est immuable', async () => {
    const id = randomUUID();
    const [inserted] = await sql('insert into recours (id, claim_id, "from", "to", amount) values (?, ?, ?, ?, ?) returning reference', [id, `ref-${run}-raw`, 'CAAT', 'SAA', 5]);
    expect(inserted.reference).toMatch(/^REC-\d{4}-\d{5,}$/);
    await expect(sql('update recours set reference = ? where id = ?', ['REC-1999-00001', id])).rejects.toThrow(/immuable/);
    await expect(sql('update recours set state = ? where id = ?', ['REJETE', id])).resolves.toBeDefined();
    const [after] = await sql('select reference from recours where id = ?', [id]);
    expect(after.reference).toBe(inserted.reference);
  });

  it('dossier de commission : référence CSC et référence du recours dénormalisée, inchangées après les transitions', async () => {
    const r = await recours.create({ claimId: `ref-${run}-csc`, from: 'CAAT', to: 'SAA', amount: 4_000 }, place());
    await recours.transition(r.id, { action: 'opposer' }, corr('SAA'));
    await recours.transition(r.id, { action: 'contester' }, corr('CAAT'));
    await recours.transition(r.id, { action: 'transmettre_commission' }, corr('CAAT'));
    const kase = await commission.createCase({ recoursId: r.id, motif: 'Montant contesté' }, member('sec'));
    expect(kase.reference).toMatch(/^CSC-\d{4}-\d{3,}$/);
    expect(kase.recoursReference).toBe(r.reference);
    await commission.deliberate(kase.id, member('a'));
    const [row] = await sql('select reference, recours_reference from commission_case where id = ?', [kase.id]);
    expect(row).toEqual({ reference: kase.reference, recours_reference: r.reference });
    expect((await recours.get(r.id)).reference).toBe(r.reference);
  });
});
