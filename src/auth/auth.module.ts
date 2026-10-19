import { Global, Module } from '@nestjs/common';
import { getDevJwtSecret } from '../common/config/env.validation';
import { PlaceUserDirectoryModule } from '../common/directory/place-user-directory.module';
import { AUTH_PROVIDER, AuthProvider } from '../common/interfaces/authenticated-user.interface';
import { RbacService } from '../common/rbac/rbac.service';
import { AuthController } from './auth.controller';
import { DevAuthProvider } from './strategies/dev-auth.provider';
import { KeycloakStrategy } from './strategies/keycloak.strategy';

/**
 * Sélection du fournisseur d'authentification au démarrage — SEC-01.
 *
 * Matrice NODE_ENV × AUTH_PROVIDER :
 *  - `keycloak` : toujours accepté (configuration Keycloak minimale exigée) ;
 *  - `dev` : refusé si `NODE_ENV=production` ; ailleurs, exige un
 *    `DEV_JWT_SECRET` réel (ni absent, ni égal à la valeur publique de
 *    `.env.example` — seule exception : clé éphémère sous Jest) ;
 *  - toute autre valeur (absente, mal orthographiée) : refusée.
 *
 * Exportée pour être testée unitairement sans conteneur Nest
 * (`auth-provider-selection.spec.ts`).
 */
export function selectAuthProvider(env: Record<string, string | undefined>, dev: DevAuthProvider, keycloak: KeycloakStrategy): AuthProvider {
  const provider = env.AUTH_PROVIDER;
  if (env.NODE_ENV === 'production' && provider !== 'keycloak') {
    throw new Error(
      `AUTH_PROVIDER doit valoir "keycloak" en production (valeur actuelle: ${JSON.stringify(provider ?? null)}) — ` +
        'le fournisseur de développement (en-tête x-dev-user non signé) y est interdit.',
    );
  }
  if (provider === 'keycloak') {
    // Vérifié ICI (au démarrage, quand ce provider est effectivement
    // sélectionné) plutôt que dans le constructeur de KeycloakStrategy
    // (toujours instancié par Nest aux côtés de DevAuthProvider) —
    // zero-trust : jamais de repli admin silencieux si la config
    // Keycloak est incomplète (voir keycloak.strategy.ts).
    keycloak.assertConfigured();
    return keycloak;
  }
  if (provider === 'dev') {
    // SEC-01 : plus de repli `?? 'dev-local-only-secret-change-me'` — lève si absent ou public.
    getDevJwtSecret(env);
    dev.announce();
    return dev;
  }
  // Revue sécurité 2026-10-18 : toute valeur autre que 'dev'/'keycloak'
  // (y compris absente/mal orthographiée) basculait SILENCIEUSEMENT sur
  // `DevAuthProvider` — contournement total de l'authentification.
  throw new Error(
    `AUTH_PROVIDER doit valoir "dev" ou "keycloak" (valeur actuelle: ${JSON.stringify(provider ?? null)}). ` +
      'Aucun repli implicite sur DevAuthProvider — voir .env.example.',
  );
}

/**
 * AuthModule — intégration identité (B.7). Le fournisseur effectif est
 * choisi par `AUTH_PROVIDER` (dev | keycloak), injecté derrière le jeton
 * `AUTH_PROVIDER` consommé par `AuthGuard` et la passerelle temps réel.
 * `RbacService` est exporté pour être réutilisé par AdminModule (édition de
 * la matrice, écran 14).
 *
 * Importe `PlaceUserDirectoryModule` (et non `AdminModule`, qui importe
 * lui-même `AuthModule` — une dépendance inverse aurait formé un cycle) :
 * `KeycloakStrategy` y lit l'état du compte et les dérogations grant/revoke
 * (`PlaceUser`). Voir `common/directory/place-user-directory.service.ts`.
 *
 * `@Global()` : `AuthGuard`/`PrivilegesGuard` sont utilisés par la quasi-
 * totalité des modules (B.2 : "tous").
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
      useFactory: (dev: DevAuthProvider, keycloak: KeycloakStrategy) => selectAuthProvider(process.env, dev, keycloak),
    },
  ],
  exports: [RbacService, AUTH_PROVIDER],
})
export class AuthModule {}
