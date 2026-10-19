import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { MAX_PAGE_SIZE } from '../../recours/dto/recours.dto';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination.dto';
import { MEMBERSHIP_STATES, MEMBERSHIP_TYPES } from '../membership.rules';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ListMembershipRequestsQueryDto {
  @ApiPropertyOptional({ enum: MEMBERSHIP_TYPES }) @IsOptional() @IsIn(MEMBERSHIP_TYPES as unknown as string[]) type?: string;
  @ApiPropertyOptional({ enum: MEMBERSHIP_STATES }) @IsOptional() @IsIn(MEMBERSHIP_STATES as unknown as string[]) state?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) page: number = 1;
  @ApiPropertyOptional({ maximum: MAX_PAGE_SIZE }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE_SIZE) pageSize: number = DEFAULT_PAGE_SIZE;
}

export class CreateMembershipRequestDto {
  @ApiProperty({ enum: MEMBERSHIP_TYPES })
  @IsIn(MEMBERSHIP_TYPES as unknown as string[])
  type!: string;

  @ApiProperty({ description: "Date de réception du courrier à l'UAR (AAAA-MM-JJ) — ni future, ni antérieure de plus de MEMBERSHIP_RECEIVED_MAX_AGE_DAYS jours (30 par défaut)" })
  @Matches(ISO_DATE, { message: 'receivedAt doit être une date AAAA-MM-JJ' })
  receivedAt!: string;

  @ApiProperty({ description: 'SEC-47 : référence du courrier reçu (obligatoire)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  letterRef!: string;

  @ApiPropertyOptional({ description: 'RETRAIT : id (référentiel) de la compagnie adhérente qui se retire — obligatoire' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional({ description: 'ADHESION : raison sociale de la société candidate — obligatoire' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  candidateName?: string;

  @ApiPropertyOptional({ description: "Référence de l'agrément pour la branche automobile" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  agrementRef?: string;
}

export class AcceptMembershipRequestDto {
  @ApiPropertyOptional({ description: "Référence d'agrément branche automobile (Art. 30-35) — obligatoire si absente de la demande" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  agrementRef?: string;

  @ApiPropertyOptional({ description: 'Id de la compagnie créée au référentiel (POST /referential/companies), si déjà créée' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  decisionNote?: string;
}

export class RejectMembershipRequestDto {
  @ApiProperty({ description: 'Motif du rejet' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  decisionNote!: string;
}

export class MembershipNoteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  decisionNote?: string;
}

export class MembershipRequestViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: MEMBERSHIP_TYPES }) type!: string;
  @ApiProperty({ enum: MEMBERSHIP_STATES }) state!: string;
  @ApiPropertyOptional() companyId?: string;
  @ApiPropertyOptional() companyCode?: string;
  @ApiPropertyOptional() candidateName?: string;
  @ApiPropertyOptional() agrementRef?: string;
  @ApiProperty() receivedAt!: string;
  @ApiPropertyOptional({ description: 'RETRAIT : 31/12 de l’année de réception si reçue au plus tard le 30/09, sinon 31/12 de l’année suivante' }) effectiveDate?: string;
  @ApiPropertyOptional({ description: 'Référence du courrier reçu (SEC-47)' }) letterRef?: string;
  @ApiPropertyOptional() decidedAt?: string;
  @ApiPropertyOptional() decidedBy?: string;
  @ApiPropertyOptional() decisionNote?: string;
  @ApiProperty() createdBy!: string;
  @ApiProperty() createdAt!: string;
}
