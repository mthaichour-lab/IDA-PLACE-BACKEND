import { readFileSync } from 'fs';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

/**
 * Configuration MikroORM (CLI + runtime).
 *
 * IMPORTANT (mode dégradé) : `connect: false` évite que l'initialisation de
 * l'ORM ne bloque/plante le démarrage de Nest si PostgreSQL n'est pas
 * joignable (environnement de dev sans docker-compose lancé). La première
 * requête réelle échouera alors proprement ; hors production, chaque service
 * métier qui dépend de la base bascule sur un repository de secours en
 * mémoire sur erreur de CONNEXION uniquement (voir
 * `src/common/interfaces/degraded-mode.ts`). En production, aucun repli : les
 * écritures répondent 503 et la sonde `GET /api/v1/health/ready` échoue.
 *
 * SEC-23 (revue sécurité 2026-10-19) :
 *  - plus aucun identifiant de repli en production (`DB_PASSWORD ?? 'ida_place'`) :
 *    `buildMikroOrmConfig` lève une erreur si une variable manque ;
 *  - TLS PostgreSQL : `DB_SSL` (défaut `true` en production), `DB_SSL_CA`
 *    (PEM ou chemin de fichier), `DB_SSL_REJECT_UNAUTHORIZED` (défaut `true`) ;
 *  - `debug` (journalisation des requêtes ET de leurs paramètres, donc de
 *    données personnelles) : uniquement si `NODE_ENV=development` ET
 *    `DB_DEBUG=true`.
 *
 * Les migrations ne sont jamais exécutées au démarrage de l'API : elles sont
 * lancées par un job dédié (`npm run migration:up`) avec le rôle SQL de
 * migration, distinct du rôle applicatif (voir la migration du journal scellé).
 */
type Env = Record<string, string | undefined>;

function sslOptions(env: Env): false | { rejectUnauthorized: boolean; ca?: string } {
  const prod = env.NODE_ENV === 'production';
  const enabled = env.DB_SSL !== undefined ? env.DB_SSL === 'true' : prod;
  if (!enabled) return false;
  const caRaw = env.DB_SSL_CA;
  const ca = caRaw ? (caRaw.includes('-----BEGIN') ? caRaw : readFileSync(caRaw, 'utf8')) : undefined;
  return { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false', ...(ca ? { ca } : {}) };
}

export function buildMikroOrmConfig(env: Env = process.env) {
  const prod = env.NODE_ENV === 'production';
  if (prod) {
    const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter((k) => !env[k]);
    if (missing.length > 0) {
      throw new Error(`Configuration base de données incomplète en production (${missing.join(', ')}) — aucune valeur de repli.`);
    }
  }
  const ssl = sslOptions(env);
  return defineConfig({
    host: env.DB_HOST ?? 'localhost',
    port: Number(env.DB_PORT ?? 5432),
    dbName: env.DB_NAME ?? 'ida_place',
    user: env.DB_USER ?? 'ida_place',
    // Repli de développement uniquement (docker-compose local) : refusé en production ci-dessus.
    password: env.DB_PASSWORD ?? (prod ? undefined : 'ida_place'),
    entities: ['dist/**/*.entity.js'],
    entitiesTs: ['src/**/*.entity.ts'],
    extensions: [Migrator],
    migrations: {
      // Sortie de `nest build` : `dist/src/...` (mikro-orm.config.ts est à la racine, donc rootDir = racine du dépôt).
      path: 'dist/src/migrations',
      pathTs: 'src/migrations',
      glob: '!(*.d).{js,ts}',
    },
    connect: false,
    ...(ssl ? { driverOptions: { connection: { ssl } } } : {}),
    debug: env.NODE_ENV === 'development' && env.DB_DEBUG === 'true',
  });
}
