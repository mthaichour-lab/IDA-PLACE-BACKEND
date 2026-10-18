import { Global, Module } from '@nestjs/common';
import { PlaceUserDirectoryModule } from '../common/directory/place-user-directory.module';
import { AUTH_PROVIDER } from '../common/interfaces/authenticated-user.interface';
import { RbacService } from '../common/rbac/rbac.service';
import { AuthController } from './auth.controller';
import { DevAuthProvider } from './strategies/dev-auth.provider';
import { KeycloakStrategy } from './strategies/keycloak.strategy';

/**
 * AuthModule — intégration identité (B.7). Le fournisseur effectif est
 * choisi par `AUTH_PROVIDER` (dev | keycloak), injecté derrière le jeton
 * `AUTH_PROVIDER` consommé par `AuthGuard`. `RbacService` est exporté pour
 * être réutilisé par AdminModule (édition de la matrice, écran 14).
 *
 * Importe `PlaceUserDirectoryModule` (et non `AdminModule`, qui importe
 * lui-même `AuthModule` — une dépendance inverse aurait formé un cycle) :
 * `KeycloakStrategy` y lit les dérogations grant/revoke par utilisateur
 * (`PlaceUser`, même miroir applicatif que l'écran 14 "Paramétrage"). Voir
 * `common/directory/place-user-directory.service.ts`.
 *
 * `@Global()` : `AuthGuard`/`PrivilegesGuard` sont utilisés par la quasi-
 * totalité des modules (B.2 : "tous"). Plutôt que de faire importer
 * `AuthModule` par chacun des 17 modules, on l'enregistre une seule fois
 * (dans AppModule) et on l'expose globalement — pattern NestJS standard
 * pour un module d'infrastructure transverse (auth, logging...).
 */
@Global()
@Module({
  imports: [PlaceUserDirectoryModule],
  controllers: [AuthController],
  providers: [
    RbacService,
    DevAuthProvider,
    KeycloakStrategy,
    {
      provide: AUTH_PROVIDER,
      inject: [DevAuthProvider, KeycloakStrategy],
      useFactory: (dev: DevAuthProvider, keycloak: KeycloakStrategy) => {
        if (process.env.AUTH_PROVIDER === 'keycloak') {
          // Vérifié ICI (au démarrage, quand ce provider est effectivement
          // sélectionné) plutôt que dans le constructeur de KeycloakStrategy
          // (toujours instancié par Nest aux côtés de DevAuthProvider) —
          // zero-trust : jamais de repli admin silencieux si la config
          // Keycloak est incomplète (voir keycloak.strategy.ts).
          keycloak.assertConfigured();
          return keycloak;
        }
        if (process.env.AUTH_PROVIDER === 'dev') {
          return dev;
        }
        // Revue sécurité 2026-10-18 : AVANT, toute valeur autre que
        // 'keycloak' (y compris absente/mal orthographiée) basculait
        // SILENCIEUSEMENT sur `DevAuthProvider` — qui authentifie N'IMPORTE
        // QUEL rôle (y compris ADMIN_UAR) depuis un simple en-tête
        // `x-dev-user` non signé, sans aucune vérification. Dans un
        // environnement réellement exposé, une variable d'env
        // AUTH_PROVIDER oubliée ou mal orthographiée aurait donc été un
        // contournement total de l'authentification, pas un repli dégradé.
        // Exactement le genre de "triche sur la sécurité" que la règle du
        // mode dégradé (voir degraded-mode.ts) interdit explicitement —
        // désormais la valeur doit être EXPLICITEMENT 'dev' ou 'keycloak'.
        throw new Error(
          `AUTH_PROVIDER doit valoir "dev" ou "keycloak" (valeur actuelle: ${JSON.stringify(process.env.AUTH_PROVIDER ?? null)}). ` +
            'Aucun repli implicite sur DevAuthProvider — voir .env.example.',
        );
      },
    },
  ],
  exports: [RbacService, AUTH_PROVIDER],
})
export class AuthModule {}
