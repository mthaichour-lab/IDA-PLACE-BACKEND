import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

/**
 * Configuration MikroORM (CLI + runtime).
 *
 * IMPORTANT (mode dégradé) : `connect: false` évite que l'initialisation de
 * l'ORM ne bloque/plante le démarrage de Nest si PostgreSQL n'est pas
 * joignable (environnement de dev sans docker-compose lancé). La première
 * requête réelle échouera alors proprement ; chaque service métier qui
 * dépend de la base intercepte cette erreur et bascule sur un repository de
 * secours en mémoire (voir `src/common/interfaces/degraded-mode.ts`).
 * Ce n'est jamais le cas en production : `DB_RUN_MIGRATIONS_ON_BOOT` et la
 * supervision (readiness probe) doivent alors exiger une connexion saine.
 */
export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  dbName: process.env.DB_NAME ?? 'ida_place',
  user: process.env.DB_USER ?? 'ida_place',
  password: process.env.DB_PASSWORD ?? 'ida_place',
  entities: ['dist/**/*.entity.js'],
  entitiesTs: ['src/**/*.entity.ts'],
  extensions: [Migrator],
  migrations: {
    path: 'dist/migrations',
    pathTs: 'src/migrations',
    glob: '!(*.d).{js,ts}',
  },
  connect: false,
  debug: process.env.NODE_ENV === 'development',
});
