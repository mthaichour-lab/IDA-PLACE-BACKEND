import { DriverException, NotNullConstraintViolationException, UniqueConstraintViolationException } from '@mikro-orm/core';
import { ArgumentsHost, BadRequestException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { NormalizedExceptionFilter } from './normalized-exception.filter';

function fakeHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res = { status };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

/**
 * Revue sécurité 2026-10-18 : une `Error` non-HTTP (panne ORM/driver,
 * exception JS inattendue) ne doit JAMAIS renvoyer son `.message` brut au
 * client (peut contenir noms de table/colonne, chemins, détails internes)
 * — seul le message générique part au client, le message réel reste
 * serveur (log uniquement).
 */
describe('NormalizedExceptionFilter', () => {
  it('ne renvoie jamais le message brut d’une Error non-HTTP au client', () => {
    const filter = new NormalizedExceptionFilter();
    const { host, status, json } = fakeHost();

    filter.catch(new Error('relation "claim" column "montant_secret_interne" does not exist'), host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0];
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('Erreur interne inattendue.');
    expect(body.message).not.toMatch(/montant_secret_interne|relation|column/);
  });

  it('SEC-08 : base injoignable → 503 SERVICE_UNAVAILABLE, message générique', () => {
    const filter = new NormalizedExceptionFilter();
    const { host, status, json } = fakeHost();
    filter.catch(new DriverException(Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' })), host);
    expect(status).toHaveBeenCalledWith(503);
    expect(json.mock.calls[0][0].code).toBe('SERVICE_UNAVAILABLE');
    expect(json.mock.calls[0][0].message).not.toMatch(/10\.0\.0\.5/);
  });

  it('SEC-08 : violation d’unicité → 409 CONFLICT sans détail du pilote', () => {
    const filter = new NormalizedExceptionFilter();
    const { host, status, json } = fakeHost();
    filter.catch(new UniqueConstraintViolationException(Object.assign(new Error('duplicate key value violates unique constraint "place_user_email_unique"'), { code: '23505' })), host);
    expect(status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0]).toMatchObject({ code: 'CONFLICT' });
    expect(json.mock.calls[0][0].message).not.toMatch(/place_user/);
  });

  it('SEC-08 : valeur trop longue (22001) ou NOT NULL → 400', () => {
    const filter = new NormalizedExceptionFilter();
    const a = fakeHost();
    filter.catch(new DriverException(Object.assign(new Error('value too long'), { code: '22001' })), a.host);
    expect(a.status).toHaveBeenCalledWith(400);
    const b = fakeHost();
    filter.catch(new NotNullConstraintViolationException(Object.assign(new Error('null value'), { code: '23502' })), b.host);
    expect(b.status).toHaveBeenCalledWith(400);
  });

  it('codes normalisés 429 et 503 pour les HttpException correspondantes', () => {
    const filter = new NormalizedExceptionFilter();
    const a = fakeHost();
    filter.catch(new HttpException('Trop de requêtes', 429), a.host);
    expect(a.json.mock.calls[0][0].code).toBe('TOO_MANY_REQUESTS');
    const b = fakeHost();
    filter.catch(new ServiceUnavailableException(), b.host);
    expect(b.json.mock.calls[0][0].code).toBe('SERVICE_UNAVAILABLE');
  });

  it('renvoie bien le message normalisé pour une HttpException (comportement inchangé)', () => {
    const filter = new NormalizedExceptionFilter();
    const { host, status, json } = fakeHost();

    filter.catch(new BadRequestException({ code: 'BAD_REQUEST', message: 'Champ requis manquant.' }), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0]).toMatchObject({ code: 'BAD_REQUEST', message: 'Champ requis manquant.' });
  });
});
