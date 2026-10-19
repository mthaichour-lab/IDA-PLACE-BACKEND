import { DriverException, UniqueConstraintViolationException } from '@mikro-orm/core';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { isDatabaseUnavailableError, simulatedDatabaseOutage } from '../database/db-errors';
import { withDegradedFallback } from './degraded-mode';

/**
 * SEC-08 — `withDegradedFallback` ne doit plus avaler les `HttpException` ni
 * les violations de contrainte, ne se replier que sur une erreur de
 * connexion identifiée, et jamais en production (503).
 */
describe('withDegradedFallback (SEC-08)', () => {
  const originalEnv = process.env.NODE_ENV;
  const fallback = jest.fn(() => 'repli');

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    fallback.mockClear();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('relance une ConflictException levée dans l’opération (409), sans repli', async () => {
    await expect(withDegradedFallback('t', () => Promise.reject(new ConflictException('doublon')), fallback)).rejects.toBeInstanceOf(ConflictException);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('relance une NotFoundException (et toute HttpException)', async () => {
    await expect(withDegradedFallback('t', () => Promise.reject(new NotFoundException()), fallback)).rejects.toBeInstanceOf(NotFoundException);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('relance une violation de contrainte (unicité)', async () => {
    const err = new UniqueConstraintViolationException(Object.assign(new Error('duplicate key'), { code: '23505' }));
    await expect(withDegradedFallback('t', () => Promise.reject(err), fallback)).rejects.toBe(err);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('relance une valeur trop longue (SQLSTATE 22001) — plus de « sanction prononcée » sans exister', async () => {
    const err = new DriverException(Object.assign(new Error('value too long for type character varying(255)'), { code: '22001' }));
    await expect(withDegradedFallback('t', () => Promise.reject(err), fallback)).rejects.toBe(err);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('relance un bogue applicatif (TypeError) hors Jest', async () => {
    await expect(withDegradedFallback('t', () => Promise.reject(new TypeError('x is undefined')), fallback)).rejects.toBeInstanceOf(TypeError);
  });

  it('se replie sur une erreur de connexion identifiée, hors production', async () => {
    await expect(withDegradedFallback('t', () => Promise.reject(simulatedDatabaseOutage()), fallback)).resolves.toBe('repli');
    const authFailure = new DriverException(Object.assign(new Error('password authentication failed'), { code: '28P01' }));
    await expect(withDegradedFallback('t', () => Promise.reject(authFailure), fallback)).resolves.toBe('repli');
  });

  it('production : aucun repli, 503 SERVICE_UNAVAILABLE', async () => {
    process.env.NODE_ENV = 'production';
    await expect(withDegradedFallback('t', () => Promise.reject(simulatedDatabaseOutage()), fallback)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('production : une HttpException reste une HttpException (pas de 503)', async () => {
    process.env.NODE_ENV = 'production';
    await expect(withDegradedFallback('t', () => Promise.reject(new ConflictException()), fallback)).rejects.toBeInstanceOf(ConflictException);
  });

  it('Jest (NODE_ENV=test) : compatibilité des doubles existants — Error générique assimilée à une panne, contraintes toujours relancées', async () => {
    process.env.NODE_ENV = 'test';
    await expect(withDegradedFallback('t', () => Promise.reject(new Error('DB injoignable (test)')), fallback)).resolves.toBe('repli');
    const err = new UniqueConstraintViolationException(new Error('duplicate key'));
    await expect(withDegradedFallback('t', () => Promise.reject(err), fallback)).rejects.toBe(err);
    await expect(withDegradedFallback('t', () => Promise.reject(new ConflictException()), fallback)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('isDatabaseUnavailableError (SEC-08)', () => {
  it.each([
    ['ECONNREFUSED', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['ENOTFOUND', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })],
    ['28P01 (authentification)', new DriverException(Object.assign(new Error('auth'), { code: '28P01' }))],
    ['3D000 (base inexistante)', new DriverException(Object.assign(new Error('db'), { code: '3D000' }))],
    ['08006 (connexion perdue)', new DriverException(Object.assign(new Error('conn'), { code: '08006' }))],
    ['57P01 (arrêt serveur)', new DriverException(Object.assign(new Error('shutdown'), { code: '57P01' }))],
    ['délai knex', new DriverException(new Error('Knex: Timeout acquiring a connection. The pool is probably full.'))],
    ['AggregateError IPv4/IPv6', Object.assign(new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' })]), {})],
    ['cause chaînée', new Error('wrap', { cause: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) })],
  ])('reconnaît %s', (_label, err) => {
    expect(isDatabaseUnavailableError(err)).toBe(true);
  });

  it.each([
    ['contrainte', new UniqueConstraintViolationException(Object.assign(new Error('dup'), { code: '23505' }))],
    ['table absente', new DriverException(Object.assign(new Error('relation does not exist'), { code: '42P01' }))],
    ['TypeError', new TypeError('boom')],
    ['HttpException', new ConflictException()],
    ['undefined', undefined],
  ])('ne confond pas %s avec une panne de connexion', (_label, err) => {
    expect(isDatabaseUnavailableError(err)).toBe(false);
  });
});
