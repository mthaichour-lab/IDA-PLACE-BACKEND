import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';

/**
 * Revue sécurité 2026-10-18 : AVANT, toute valeur de `AUTH_PROVIDER` autre
 * que `'keycloak'` (y compris absente ou mal orthographiée) basculait
 * SILENCIEUSEMENT sur `DevAuthProvider` — qui authentifie n'importe quel
 * rôle (y compris ADMIN_UAR) depuis un simple en-tête `x-dev-user` non
 * signé. Dans un environnement réellement exposé, une variable d'env
 * oubliée aurait donc été un contournement total de l'authentification.
 * Désormais, `AUTH_PROVIDER` doit être EXPLICITEMENT "dev" ou "keycloak" —
 * toute autre valeur fait échouer le démarrage (voir auth.module.ts).
 *
 * Réutilise `AppModule` complet (mêmes conditions que `createTestApp`,
 * mode dégradé sans PostgreSQL réel) plutôt qu'un module `AuthModule`
 * isolé, pour éviter de re-câbler ses dépendances MikroORM à la main —
 * `AUTH_PROVIDER` est restauré dans un `finally` pour ne jamais fuiter
 * vers un autre fichier de test exécuté dans le même worker Jest.
 */
describe('Sélection du AuthProvider (revue sécurité 2026-10-18)', () => {
  const original = process.env.AUTH_PROVIDER;

  afterEach(() => {
    process.env.AUTH_PROVIDER = original;
  });

  it('échoue au démarrage si AUTH_PROVIDER est absent (jamais un repli silencieux sur dev)', async () => {
    delete process.env.AUTH_PROVIDER;
    await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(/AUTH_PROVIDER doit valoir "dev" ou "keycloak"/);
  });

  it('échoue au démarrage si AUTH_PROVIDER est mal orthographié (ex: "Dev", "keycloack")', async () => {
    process.env.AUTH_PROVIDER = 'Dev';
    await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(/AUTH_PROVIDER doit valoir "dev" ou "keycloak"/);
  });

  it('démarre normalement avec AUTH_PROVIDER="dev" explicite (comportement inchangé)', async () => {
    process.env.AUTH_PROVIDER = 'dev';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    await app.close();
  });
});
