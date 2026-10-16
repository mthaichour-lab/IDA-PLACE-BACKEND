import { Global, Module } from '@nestjs/common';
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
 * `@Global()` : `AuthGuard`/`PrivilegesGuard` sont utilisés par la quasi-
 * totalité des modules (B.2 : "tous"). Plutôt que de faire importer
 * `AuthModule` par chacun des 17 modules, on l'enregistre une seule fois
 * (dans AppModule) et on l'expose globalement — pattern NestJS standard
 * pour un module d'infrastructure transverse (auth, logging...).
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    RbacService,
    DevAuthProvider,
    KeycloakStrategy,
    {
      provide: AUTH_PROVIDER,
      inject: [DevAuthProvider, KeycloakStrategy],
      useFactory: (dev: DevAuthProvider, keycloak: KeycloakStrategy) =>
        process.env.AUTH_PROVIDER === 'keycloak' ? keycloak : dev,
    },
  ],
  exports: [RbacService, AUTH_PROVIDER],
})
export class AuthModule {}
