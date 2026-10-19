import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { isDataException, isDatabaseUnavailableError, isUniqueOrForeignKeyViolation, isConstraintViolation } from '../database/db-errors';
import { sanitizeForLog } from '../logging/sanitize-log';

/**
 * Erreurs normalisées — B.11 : `{code, message, details}` sur toute réponse
 * d'erreur de l'API, quel que soit le module qui l'a levée.
 *
 * SEC-08 (revue sécurité 2026-10-19) : les erreurs de base qui ne sont plus
 * masquées par le repli mémoire reçoivent un statut HTTP exact, avec un
 * message générique (jamais le message du pilote, qui contient noms de
 * table/colonne et valeurs) :
 *  - base injoignable → 503 `SERVICE_UNAVAILABLE` ;
 *  - violation d'unicité ou de clé étrangère → 409 `CONFLICT` ;
 *  - autre violation de contrainte ou valeur invalide (SQLSTATE 22xxx,
 *    ex. valeur trop longue) → 400 `BAD_REQUEST`.
 * SEC-45 : les messages journalisés sont neutralisés (une ligne, longueur bornée).
 */
@Catch()
export class NormalizedExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Erreur interne inattendue.';
    let details: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      code = httpStatusToCode(status);
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        message = (b.message as string) ?? exception.message;
        details = b.details ?? (Array.isArray(b.message) ? b.message : undefined);
        if (typeof b.code === 'string') code = b.code;
      }
    } else if (isDatabaseUnavailableError(exception)) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'SERVICE_UNAVAILABLE';
      message = 'Service temporairement indisponible (base de données injoignable).';
      this.logger.error(`Base de données injoignable : ${sanitizeForLog(exception, 500)}`);
    } else if (isUniqueOrForeignKeyViolation(exception)) {
      status = HttpStatus.CONFLICT;
      code = 'CONFLICT';
      message = 'Conflit avec une donnée existante.';
      this.logger.warn(`Violation de contrainte : ${sanitizeForLog(exception, 500)}`);
    } else if (isConstraintViolation(exception) || isDataException(exception)) {
      status = HttpStatus.BAD_REQUEST;
      code = 'BAD_REQUEST';
      message = 'Données refusées par la base (valeur manquante, trop longue ou invalide).';
      this.logger.warn(`Donnée refusée par la base : ${sanitizeForLog(exception, 500)}`);
    } else if (exception instanceof Error) {
      // Revue sécurité 2026-10-18 : le message RÉEL (qui peut contenir des
      // noms de table/colonne, un chemin de fichier, ou d'autres détails
      // internes pour une erreur ORM/driver) reste SERVEUR uniquement — le
      // client ne reçoit que le message générique déjà initialisé
      // ci-dessus, jamais `exception.message` brut.
      this.logger.error(sanitizeForLog(exception.message, 1000), exception.stack);
    }

    res.status(status).json({ code, message, details });
  }
}

export function httpStatusToCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'PAYLOAD_TOO_LARGE';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'UNPROCESSABLE_ENTITY';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'TOO_MANY_REQUESTS';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  }
}
