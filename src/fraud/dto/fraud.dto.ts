import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FRAUD_ACTION_TYPES } from '../entities/fraud-action.entity';

export const FRAUD_CASE_TYPES = [
  'DOUBLON',
  'ECONSTAT_REUTILISE',
  'RECURRENCE_VEHICULE',
  'MONTANT_CALIBRE',
  'INCOHERENCE_AB',
  'VELOCITE_ADHERENT',
] as const;
export const FRAUD_SEVERITIES = ['FAIBLE', 'MOYENNE', 'ELEVEE'] as const;

export class FraudCaseViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: FRAUD_CASE_TYPES }) type!: string;
  @ApiProperty() score!: number;
  @ApiProperty({ enum: FRAUD_SEVERITIES }) severity!: string;
  @ApiProperty({ type: [String] }) claimIds!: string[];
  @ApiProperty({ type: [String] }) companiesInvolved!: string[];
  @ApiProperty({ type: Object }) details!: Record<string, unknown>;
  @ApiProperty() detectedAt!: string;
  /** Plaque (`Claim.plateA`) du premier dossier lié — additif, écran 9 guide illustré (colonne "Plaque"). `undefined` si aucun dossier lié n'a de plaque renseignée. */
  @ApiPropertyOptional() plateA?: string;
  /** Additif (SEC-26), rôle compagnie seulement : nombre de dossiers d'autres compagnies dans le cas (leurs id ne sont pas publiés). */
  @ApiPropertyOptional() counterpartClaims?: number;
  /** Additif (SEC-26), rôle compagnie seulement : nombre d'autres compagnies impliquées (leurs codes ne sont pas publiés). */
  @ApiPropertyOptional() counterpartCompanies?: number;
}

/**
 * Signaux groupés par catégorie pour un adhérent (écran 9, guide illustré,
 * panneau de détail) — le dossier technique §9 nomme explicitement ces
 * groupes : "Doublons & e-constat", "Réseau/récurrence", "Montants &
 * plafond", "Incohérences A/B", "Vélocité". Additif, `GET
 * /fraud/adherents/:company/signals` — n'affecte pas `FraudCaseViewDto`
 * ci-dessus (contrat non muté, simple agrégation en lecture).
 */
export const FRAUD_SIGNAL_GROUPS = ['DOUBLONS_ECONSTAT', 'RESEAU_RECURRENCE', 'MONTANTS_PLAFOND', 'INCOHERENCES_AB', 'VELOCITE'] as const;

export class FraudSignalGroupDto {
  @ApiProperty({ enum: FRAUD_SIGNAL_GROUPS }) group!: string;
  @ApiProperty({ description: 'Nombre de cas de ce groupe impliquant cet adhérent' }) count!: number;
  @ApiProperty({ description: 'Score maximal parmi les cas de ce groupe' }) maxScore!: number;
  @ApiProperty({ type: [FraudCaseViewDto], description: 'Cas sous-jacents (score décroissant)' }) cases!: FraudCaseViewDto[];
}

export class FraudActionViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: FRAUD_ACTION_TYPES }) type!: string;
  @ApiProperty() actor!: string;
  @ApiPropertyOptional() claimId?: string;
  @ApiPropertyOptional() matchId?: string;
  @ApiPropertyOptional({ type: Object }) details?: Record<string, unknown>;
  @ApiProperty() at!: string;
}
