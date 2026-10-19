import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination.dto';
import { RECOURS_ACTIONS, RECOURS_STATES } from '../recours.rules';

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
  q?: string;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize: number = DEFAULT_PAGE_SIZE;
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
  claimId!: string;

  @ApiProperty({ description: 'Compagnie demanderesse (code)' })
  @IsString()
  @IsNotEmpty()
  from!: string;

  @ApiProperty({ description: 'Compagnie adverse (code)' })
  @IsString()
  @IsNotEmpty()
  to!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  amount!: number;
}

export class RecoursTransitionDto {
  @ApiProperty({ enum: RECOURS_ACTIONS })
  @IsIn(RECOURS_ACTIONS as unknown as string[])
  action!: string;

  @ApiPropertyOptional({ description: 'Motif (opposition, contestation, décision de commission...)' })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({ description: "Action « opposer » uniquement : code du motif d'opposition (400 si inconnu ou interdit)" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  reasonCode?: string;
}

export class RecoursTransitionResultDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: RECOURS_STATES }) state!: string;
  @ApiProperty({ type: RecoursTimerDto }) timer!: RecoursTimerDto;
  @ApiProperty() transitionedAt!: string;
}
