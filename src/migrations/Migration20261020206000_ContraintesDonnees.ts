import { Migration } from '@mikro-orm/migrations';

/**
 * SEC-49 — contraintes de données garanties par la base (tables du périmètre
 * recours / compensation / commission / référentiel). Ajoutées `NOT VALID` :
 * elles s'appliquent à toute nouvelle écriture sans faire échouer la
 * migration sur d'éventuelles lignes historiques non conformes ; un
 * `VALIDATE CONSTRAINT` pourra être lancé après contrôle des données (voir
 * `down()` pour la liste).
 *
 * Hors de ce lot (autres périmètres, signalés au Tech Lead) : rôle/compagnie
 * de `place_user`, bornes de responsabilité de `claim`, unicité de `fraud_action`.
 */
const CHECKS: Array<[table: string, name: string, expr: string]> = [
  ['wilaya_population', 'wilaya_population_population_check', '"population" > 0'],
  ['wilaya_population', 'wilaya_population_reference_year_check', '"reference_year" between 1900 and 2200'],
  ['company', 'company_code_check', `"code" ~ '^[A-Z0-9]{2,4}$'`],
  ['company', 'company_status_check', `"status" in ('ACTIF', 'SUSPENDU', 'EN_RETRAIT', 'EXCLU')`],
  ['company', 'company_kind_check', `"kind" in ('INSURER', 'MUTUAL', 'SUBSIDIARY')`],
  ['company', 'company_feed_mode_check', `"feed_mode" in ('ERP', 'ECONSTAT', 'IMPORT', 'API')`],
  ['agency', 'agency_type_check', `"type" in ('DG', 'DR', 'AG')`],
  ['agency', 'agency_status_check', `"status" in ('ACTIF', 'SUSPENDU', 'EN_RETRAIT', 'EXCLU')`],
  ['agency', 'agency_parent_check', '"parent_id" is null or "parent_id" <> "id"'],
  ['expert', 'expert_status_check', `"status" in ('ACTIF', 'SUSPENDU', 'RADIE')`],
  ['recours', 'recours_amount_check', '"amount" > 0'],
  ['recours', 'recours_state_check', `"state" in ('EN_ATTENTE', 'OPPOSITION', 'CONTESTATION', 'COMMISSION', 'REGLE', 'REJETE', 'FORCLOS')`],
  ['recours', 'recours_parties_check', '"from" <> "to"'],
  ['commission_case', 'commission_case_amount_check', '"amount" >= 0'],
  ['commission_case', 'commission_case_status_check', `"status" in ('A_INSTRUIRE', 'EN_DELIBERE', 'PRONONCE')`],
  ['sanction', 'sanction_amount_check', '"amount" is null or "amount" > 0'],
  ['sanction', 'sanction_type_check', `"type" in ('PENALITE_FINANCIERE', 'AVERTISSEMENT', 'SUSPENSION')`],
  ['sanction', 'sanction_status_check', `"status" in ('A_CONTRESIGNER', 'PRONONCEE')`],
  ['sanction', 'sanction_four_eyes_check', '"countersigned_by_id" is null or "ordered_by_id" is null or "countersigned_by_id" <> "ordered_by_id"'],
  ['settlement_closure', 'settlement_closure_scope_check', `"scope" in ('MONTHLY', 'QUARTERLY')`],
  ['membership_request', 'membership_request_type_check', `"type" in ('ADHESION', 'RETRAIT')`],
  ['membership_request', 'membership_request_state_check', `"state" in ('RECUE', 'ACCEPTEE', 'REJETEE', 'EFFECTIVE', 'ANNULEE')`],
  ['irsam_benchmark', 'irsam_benchmark_value_check', '"value" >= 0'],
  ['irsam_benchmark', 'irsam_benchmark_period_check', '"period_from" <= "period_to"'],
  // Règle des quatre yeux, plancher en base : le valideur n'est jamais le créateur.
  ['constat_circumstance', 'constat_circumstance_four_eyes_check', '"validated_by" is null or "validated_by" <> "created_by"'],
  ['opposition_motif', 'opposition_motif_four_eyes_check', '"validated_by" is null or "validated_by" <> "created_by"'],
  ['vehicle_category', 'vehicle_category_four_eyes_check', '"validated_by" is null or "validated_by" <> "created_by"'],
  ['bareme_version', 'bareme_version_four_eyes_check', '"validated_by" is null or "validated_by" <> "created_by"'],
  ['irsam_benchmark', 'irsam_benchmark_four_eyes_check', '"validated_by" is null or "validated_by" <> "created_by"'],
  ['mobile_holiday', 'mobile_holiday_four_eyes_check', '"confirmed_by" is null or "confirmed_by" <> "created_by"'],
];

export class Migration20261020206000_ContraintesDonnees extends Migration {
  override async up(): Promise<void> {
    for (const [table, name, expr] of CHECKS) {
      this.addSql(`alter table "${table}" add constraint "${name}" check (${expr}) not valid;`);
    }
  }

  override async down(): Promise<void> {
    for (const [table, name] of [...CHECKS].reverse()) {
      this.addSql(`alter table "${table}" drop constraint if exists "${name}";`);
    }
  }
}
