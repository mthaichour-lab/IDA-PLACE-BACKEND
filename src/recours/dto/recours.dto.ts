import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, Length, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination.dto';
import { RECOURS_STATES } from '../recours.rules';

export class ListRecoursQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize: number = DEFAULT_PAGE_SIZE;
  @ApiPropertyOptional({ enum: RECOURS_STATES }) @IsOptional() @IsIn(RECOURS_STATES as unknown as string[]) state?: string;
}

export class CreateRecoursDto {
  @ApiProperty({ description: 'Id du dossier (ClaimsModule) concerné' })
  @IsString()
  @Length(1, 64)
  claimId!: string;

  @ApiProperty({ description: 'Compagnie à l’origine du recours (code, ex: CAAT)' })
  @IsString()
  @Length(2, 4)
  from!: string;

  @ApiProperty({ description: 'Compagnie destinataire du recours (code)' })
  @IsString()
  @Length(2, 4)
  to!: string;

  @ApiProperty()
  @IsNumber()
  @IsPositive()
  amount!: number;
}

export class OpposerRecoursDto {
  @ApiProperty({ description: "Motif de l'opposition" })
  @IsString()
  @Length(1, 2000)
  motif!: string;
}

export class ContesterRecoursDto {
  @ApiProperty({ description: 'Motif de la contestation de l’opposition' })
  @IsString()
  @Length(1, 2000)
  motif!: string;
}

export class SettleRecoursDto {
  @ApiPropertyOptional({ description: 'Montant réglé, si différent du montant initial du recours' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  amount?: number;
}

export class RecoursOppositionDto {
  @ApiProperty() motif!: string;
  @ApiProperty() at!: string;
  @ApiPropertyOptional() by?: string;
}

export class RecoursContestationDto {
  @ApiProperty() motif!: string;
  @ApiProperty() at!: string;
  @ApiPropertyOptional() by?: string;
}

/** Vue Recours — écran 4 "Échanges Annexes 2/3/4". */
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
  @ApiPropertyOptional({ description: 'Échéance courante (countdown Art. 10 ou Art. 12 selon l’état)' })
  currentDeadlineAt?: string;
}
