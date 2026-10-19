import { Matches } from 'class-validator';
import { COMPANY_CODE_PATTERN } from './claim-import.dto';

/** `:company` d'une route : code compagnie du référentiel (SEC-44). */
export class CompanyParamDto {
  @Matches(COMPANY_CODE_PATTERN, { message: 'company : code compagnie attendu.' }) company!: string;
}

/** `:code` d'une route : code compagnie du référentiel (SEC-44). */
export class CompanyCodeParamDto {
  @Matches(COMPANY_CODE_PATTERN, { message: 'code : code compagnie attendu.' }) code!: string;
}
