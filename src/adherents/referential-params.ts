import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/** SEC-44 — code de référentiel en paramètre de route (motif, cas de barème, catégorie) : majuscules, chiffres, _ et -, 64 caractères au plus. */
@Injectable()
export class CodeParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !/^[A-Z0-9_-]{1,64}$/.test(value)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Code invalide (majuscules, chiffres, _ et -, 64 caractères au plus).' });
    }
    return value;
  }
}

/** SEC-44 — code wilaya en paramètre de route : 2 chiffres. */
@Injectable()
export class WilayaCodePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !/^\d{2}$/.test(value)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Code wilaya invalide (2 chiffres).' });
    }
    return value;
  }
}
