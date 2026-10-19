import { assertDestructiveCommandAllowed, DestructiveCommandRefusedError } from './destructive-command-guard';

/** SEC-51 — `migration:down` et seeder refusés en production sans drapeau explicite. */
describe('assertDestructiveCommandAllowed (SEC-51)', () => {
  it('refuse en production sans drapeau (ou avec une valeur autre que "true")', () => {
    expect(() => assertDestructiveCommandAllowed('migration:down', { NODE_ENV: 'production' })).toThrow(DestructiveCommandRefusedError);
    expect(() => assertDestructiveCommandAllowed('seed:wilayas', { NODE_ENV: 'production', ALLOW_PRODUCTION_DESTRUCTIVE: 'yes' })).toThrow(
      /ALLOW_PRODUCTION_DESTRUCTIVE=true/,
    );
  });

  it('autorise en production avec ALLOW_PRODUCTION_DESTRUCTIVE=true, et hors production', () => {
    expect(() => assertDestructiveCommandAllowed('migration:down', { NODE_ENV: 'production', ALLOW_PRODUCTION_DESTRUCTIVE: 'true' })).not.toThrow();
    expect(() => assertDestructiveCommandAllowed('migration:down', { NODE_ENV: 'development' })).not.toThrow();
  });
});
