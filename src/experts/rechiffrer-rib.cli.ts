import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';
import { parseRibKey, planLegacyRibReencryption, RIB_ENVELOPE_PREFIX } from './rib-cipher';

/**
 * SEC-49 — rechiffrement des RIB d'experts hérités (stockés en clair avant
 * la remédiation). Procédure complète : docs/DEPLOIEMENT.md § « Rechiffrement
 * des RIB hérités ».
 *
 *   npm run experts:rechiffrer-rib            # inventaire seul (aucune écriture)
 *   npm run experts:rechiffrer-rib -- --apply # chiffre et écrit, en une transaction
 *
 * Image de production : job `migrator` (`node dist/src/experts/rechiffrer-rib.cli.js [--apply]`),
 * avec `EXPERT_RIB_KEY` (la MÊME clé que l'API) et les `DB_*` du rôle de migration.
 * Idempotent : une ligne déjà chiffrée (`v1:…`) n'est jamais retouchée. Aucun
 * RIB n'est affiché, seuls les identifiants et le nombre de lignes.
 */
async function run(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const key = parseRibKey(process.env.EXPERT_RIB_KEY);
  if (!key) throw new Error('EXPERT_RIB_KEY est obligatoire (même clé que l’API).');

  const orm = await MikroORM.init({ ...config, connect: true });
  try {
    await orm.em.transactional(async (em) => {
      const conn = em.getConnection();
      const rows = (await conn.execute(
        `select "id", "rib" from "expert" where "rib" is not null and btrim("rib") <> '' and "rib" not like ? for update`,
        [`${RIB_ENVELOPE_PREFIX}%`],
      )) as Array<{ id: string; rib: string | null }>;
      const plan = planLegacyRibReencryption(rows, key);
      console.log(`RIB hérités en clair : ${plan.length}${plan.length ? ` (experts ${plan.map((p) => p.id).join(', ')})` : ''}.`);
      if (!apply) {
        console.log('Inventaire seul : relancer avec --apply pour chiffrer.');
        return;
      }
      for (const p of plan) {
        await conn.execute(`update "expert" set "rib" = ?, "rib_last4" = ? where "id" = ? and "rib" not like ?`, [p.rib, p.ribLast4, p.id, `${RIB_ENVELOPE_PREFIX}%`]);
      }
      console.log(`${plan.length} RIB chiffré(s).`);
    });
  } finally {
    await orm.close(true);
  }
}

run().catch((err: unknown) => {
  console.error((err as Error)?.message ?? err);
  process.exit(1);
});
