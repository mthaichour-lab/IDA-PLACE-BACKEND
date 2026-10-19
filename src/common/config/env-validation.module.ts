import { Global, Logger, Module } from '@nestjs/common';
import { EnvValidationResult, validateEnv } from './env.validation';

export const VALIDATED_ENV = Symbol('VALIDATED_ENV');

/**
 * Exécute `validateEnv()` à la compilation du module racine : une
 * configuration invalide (secret manquant en production, AUTH_PROVIDER=dev en
 * production, CORS "*", …) fait échouer le démarrage avec la liste complète
 * des problèmes, avant toute requête. Validation à la compilation (et non au
 * chargement de `app.module.ts`) pour que les tests puissent faire varier
 * l'environnement d'une compilation à l'autre.
 */
@Global()
@Module({
  providers: [
    {
      provide: VALIDATED_ENV,
      useFactory: (): EnvValidationResult => {
        const result = validateEnv(process.env);
        const logger = new Logger('EnvValidation');
        for (const w of result.warnings) logger.warn(w);
        return result;
      },
    },
  ],
  exports: [VALIDATED_ENV],
})
export class EnvValidationModule {}
