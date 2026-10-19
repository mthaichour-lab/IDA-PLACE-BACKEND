import { buildMikroOrmConfig } from './database.config';

type WithDriverOptions = { driverOptions?: { connection?: { ssl?: unknown } } };

/** SEC-23 — configuration MikroORM : aucun identifiant de repli en production, TLS, debug. */
describe('buildMikroOrmConfig (SEC-23)', () => {
  const prod = { NODE_ENV: 'production', DB_HOST: 'db', DB_NAME: 'ida', DB_USER: 'app', DB_PASSWORD: 'secret' };

  it('production : refuse de construire la configuration si un identifiant manque', () => {
    expect(() => buildMikroOrmConfig({ ...prod, DB_PASSWORD: undefined })).toThrow(/DB_PASSWORD/);
    expect(() => buildMikroOrmConfig({ NODE_ENV: 'production' })).toThrow(/DB_HOST, DB_NAME, DB_USER, DB_PASSWORD/);
  });

  it('production : TLS activé par défaut, certificats vérifiés', () => {
    const config = buildMikroOrmConfig(prod) as WithDriverOptions;
    expect(config.driverOptions?.connection?.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('TLS : CA PEM en ligne, et désactivation explicite', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    const config = buildMikroOrmConfig({ ...prod, DB_SSL_CA: pem }) as WithDriverOptions;
    expect(config.driverOptions?.connection?.ssl).toEqual({ rejectUnauthorized: true, ca: pem });
    expect((buildMikroOrmConfig({ ...prod, DB_SSL: 'false' }) as WithDriverOptions).driverOptions).toBeUndefined();
  });

  it('développement : repli docker-compose conservé, debug seulement si DB_DEBUG=true', () => {
    const dev = buildMikroOrmConfig({ NODE_ENV: 'development' });
    expect(dev.password).toBe('ida_place');
    expect(dev.debug).toBe(false);
    expect(buildMikroOrmConfig({ NODE_ENV: 'development', DB_DEBUG: 'true' }).debug).toBe(true);
    expect(buildMikroOrmConfig({ ...prod, DB_DEBUG: 'true' }).debug).toBe(false);
  });
});
