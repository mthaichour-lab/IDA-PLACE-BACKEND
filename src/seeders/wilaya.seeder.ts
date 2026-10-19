import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';
import { assertDestructiveCommandAllowed } from '../common/config/destructive-command-guard';
import { Wilaya } from '../adherents/entities/wilaya.entity';
import { buildWilayaSeeds } from '../adherents/wilayas.data';

/**
 * Script de seed des 69 wilayas (B.3). Exécuter après les migrations :
 *   npm run migration:up
 *   npm run seed:wilayas
 *
 * Idempotent : ne réinsère pas une wilaya déjà présente (upsert par code).
 * Écrase les modifications locales des wilayas existantes : refusé en
 * production sans `ALLOW_PRODUCTION_DESTRUCTIVE=true` (SEC-51).
 */
async function run() {
  assertDestructiveCommandAllowed('seed:wilayas');
  const orm = await MikroORM.init({ ...config, connect: true });
  const em = orm.em.fork();

  const seeds = buildWilayaSeeds();
  let created = 0;
  let updated = 0;

  for (const s of seeds) {
    const existing = await em.findOne(Wilaya, { code: s.code });
    if (existing) {
      em.assign(existing, s);
      updated++;
    } else {
      em.create(Wilaya, s);
      created++;
    }
  }

  await em.flush();
  console.log(`Seed wilayas terminé — ${created} créées, ${updated} mises à jour (total ${seeds.length}).`);
  await orm.close(true);
}

run().catch((err) => {
  console.error('Échec du seed wilayas :', err.message);
  console.error('Vérifiez que PostgreSQL est démarré (docker-compose up postgres) et que les migrations sont appliquées.');
  process.exit(1);
});
