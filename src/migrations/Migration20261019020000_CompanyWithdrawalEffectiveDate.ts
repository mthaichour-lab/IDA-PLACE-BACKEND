import { Migration } from '@mikro-orm/migrations';

/**
 * `company.withdrawal_effective_date` — posée en même temps que
 * `status = EN_RETRAIT` (Chapitre VI Art. 30-35), pour distinguer un
 * sinistre antérieur au retrait (obligations maintenues) d'un nouveau
 * recours après la sortie (refusé, voir `ClaimsService.openRecours`,
 * audit sécurité 2026-10-19).
 */
export class Migration20261019020000_CompanyWithdrawalEffectiveDate extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table "company" add column "withdrawal_effective_date" date null;');
  }

  override async down(): Promise<void> {
    this.addSql('alter table "company" drop column "withdrawal_effective_date";');
  }
}
