import { buildMikroOrmConfig } from './src/common/config/database.config';

/**
 * Point d'entrée de la CLI MikroORM (`npm run migration:up` etc.) et du
 * seeder. La configuration est construite par `buildMikroOrmConfig`
 * (src/common/config/database.config.ts), également utilisée par `AppModule`
 * à la compilation — voir ce fichier pour le détail (SEC-23). En production,
 * une variable d'identification manquante fait échouer la commande (aucune
 * valeur de repli).
 */
export { buildMikroOrmConfig };
export default buildMikroOrmConfig(process.env);
