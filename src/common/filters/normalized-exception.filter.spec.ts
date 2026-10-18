import { ArgumentsHost, BadRequestException } from '@nestjs/common';
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

  it('renvoie bien le message normalisé pour une HttpException (comportement inchangé)', () => {
    const filter = new NormalizedExceptionFilter();
    const { host, status, json } = fakeHost();

    filter.catch(new BadRequestException({ code: 'BAD_REQUEST', message: 'Champ requis manquant.' }), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0]).toMatchObject({ code: 'BAD_REQUEST', message: 'Champ requis manquant.' });
  });
});
