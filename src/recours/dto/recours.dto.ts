import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination.dto';
import { MAX_TECHNICAL_AMOUNT_DA } from '../money';
import { RECOURS_ACTIONS, RECOURS_STATES } from '../recours.rules';

/** Code compagnie : 2 à 4 caractères majuscules/chiffres (colonnes `varchar(4)` ; codes réels de 3 lettres comme SAA ou GAM). */
export const COMPANY_CODE_PATTERN = /^[A-Z0-9]{2,4}$/;
export const COMPANY_CODE_MESSAGE = 'code compagnie : 2 à 4 caractères majuscules ou chiffres';
/** Taille de page maximale (règle « Volumétrie » du plan de remédiation). */
export const MAX_PAGE_SIZE = 100;

/** Filtres d'onglets écran 4 — "tous" en plus des états réels (RECOURS_STATES). */
export const RECOURS_FILTERS = ['TOUS', ...RECOURS_STATES] as const;

export class ListRecoursQueryDto {
  @ApiPropertyOptional({ enum: RECOURS_FILTERS, default: 'TOUS' })
  @IsOptional()
  @IsIn(RECOURS_FILTERS as unknown as string[])
  filter: string = 'TOUS';

  /** Recherche libre (id recours, dossier lié, compagnie from/to) — paramètre additif, ignoré des clients existants (pas de rupture de forme, ARCHITECTURE.md §1). */
  @ApiPropertyOptional({ description: 'Recherche libre : n° recours (id), n° dossier (claimId), compagnie (from/to)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  q?: string;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) page: number = 1;
  @ApiPropertyOptional({ maximum: MAX_PAGE_SIZE }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE_SIZE) pageSize: number = DEFAULT_PAGE_SIZE;
}

export class RecoursOppositionDto {
  @ApiProperty() raisedAt!: string;
  @ApiPropertyOptional() reason?: string;
  @ApiPropertyOptional({ description: "Code du motif d'opposition (GET /referential/opposition-motifs)" }) reasonCode?: string;
  @ApiProperty() status!: string;
  @ApiProperty() deadlineAt!: string;
  @ApiPropertyOptional() decidedAt?: string;
}

export class RecoursContestationDto {
  @ApiProperty() raisedAt!: string;
  @ApiPropertyOptional() reason?: string;
  @ApiProperty() status!: string;
}

export class RecoursResolutionDto {
  @ApiProperty() kind!: string;
  @ApiProperty() at!: string;
  @ApiPropertyOptional() note?: string;
}

/** Timer conventionnel courant — `countdownBar` front, aucun calcul côté front (C.1). */
export class RecoursTimerDto {
  @ApiProperty({ enum: ['SILENCE_ART10', 'OPPOSITION_ART12', 'FORCLUSION_ART19', 'AUCUN'] }) timerType!: string;
  @ApiPropertyOptional() deadlineAt?: string;
  @ApiProperty() remainingDays!: number;
  @ApiProperty() expired!: boolean;
}

/** Fiche recours (registre + détail) — écran 4. */
export class RecoursViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Référence métier lisible et immuable (REC-AAAA-NNNNN)', example: 'REC-2026-00296' }) reference!: string;
  @ApiProperty() claimId!: string;
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ enum: RECOURS_STATES }) state!: string;
  @ApiProperty() requestSentAt!: string;
  @ApiPropertyOptional() responseAt?: string;
  @ApiPropertyOptional({ type: RecoursOppositionDto }) opposition?: RecoursOppositionDto;
  @ApiPropertyOptional({ type: RecoursContestationDto }) contestation?: RecoursContestationDto;
  @ApiPropertyOptional() commissionAt?: string;
  @ApiPropertyOptional() settledAt?: string;
  @ApiProperty() amount!: number;
  @ApiPropertyOptional({ type: RecoursResolutionDto }) resolution?: RecoursResolutionDto;
  @ApiProperty({ type: RecoursTimerDto }) timer!: RecoursTimerDto;
  @ApiProperty() createdAt!: string;
}

export class CreateRecoursDto {
  @ApiProperty({ description: 'Id du dossier (Claim) à l’origine du recours' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(36)
  claimId!: string;

  @ApiProperty({ description: 'Compagnie demanderesse (code)' })
  @IsString()
  @Matches(COMPANY_CODE_PATTERN, { message: COMPANY_CODE_MESSAGE })
  from!: string;

  @ApiProperty({ description: 'Compagnie adverse (code)' })
  @IsString()
  @Matches(COMPANY_CODE_PATTERN, { message: COMPANY_CODE_MESSAGE })
  to!: string;

  /**
   * SEC-06 : nombre fini, deux décimales au plus, strictement positif. Le
   * service borne en plus par le montant du dossier (expertisé, sinon
   * estimé) et par le plafond conventionnel (`ELIGIBILITY_MAX_AMOUNT_DA`).
   */
  @ApiProperty({ description: 'Montant en DA (2 décimales au plus) — ≤ montant du dossier et ≤ plafond conventionnel' })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_TECHNICAL_AMOUNT_DA)
  amount!: number;
}

export class RecoursTransitionDto {
  @ApiProperty({ enum: RECOURS_ACTIONS })
  @IsIn(RECOURS_ACTIONS as unknown as string[])
  action!: string;

  @ApiPropertyOptional({ description: 'Motif (opposition, contestation, décision de commission...)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @ApiPropertyOptional({ description: "Action « opposer » uniquement : code du motif d'opposition (400 si inconnu ou interdit)" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  reasonCode?: string;
}

/** SEC-17 — une ligne d'historique (route d'audit réservée aux rôles place). */
export class RecoursHistoryEntryDto {
  @ApiProperty() at!: string;
  @ApiProperty() action!: string;
  @ApiPropertyOptional() fromState?: string;
  @ApiProperty() toState!: string;
  @ApiProperty({ description: 'Identifiant stable de l’auteur (jamais le nom affiché)' }) actorId!: string;
  @ApiProperty() actorRole!: string;
  @ApiPropertyOptional({ description: 'Compagnie partie au nom de laquelle l’acte est accompli' }) onBehalfOf?: string;
  @ApiPropertyOptional() reason?: string;
  @ApiPropertyOptional() resolutionKind?: string;
  @ApiPropertyOptional() commissionCaseId?: string;
  @ApiPropertyOptional() pvRef?: string;
}

export class RecoursTransitionResultDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: RECOURS_STATES }) state!: string;
  @ApiProperty({ type: RecoursTimerDto }) timer!: RecoursTimerDto;
  @ApiProperty() transitionedAt!: string;
}
