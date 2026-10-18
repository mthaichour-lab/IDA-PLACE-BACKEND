import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination.dto';
import { MEMBERSHIP_STATES, MEMBERSHIP_TYPES } from '../membership.rules';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ListMembershipRequestsQueryDto {
  @ApiPropertyOptional({ enum: MEMBERSHIP_TYPES }) @IsOptional() @IsIn(MEMBERSHIP_TYPES as unknown as string[]) type?: string;
  @ApiPropertyOptional({ enum: MEMBERSHIP_STATES }) @IsOptional() @IsIn(MEMBERSHIP_STATES as unknown as string[]) state?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize: number = DEFAULT_PAGE_SIZE;
}

export class CreateMembershipRequestDto {
  @ApiProperty({ enum: MEMBERSHIP_TYPES })
  @IsIn(MEMBERSHIP_TYPES as unknown as string[])
  type!: string;

  @ApiProperty({ description: "Date de réception du courrier à l'UAR (AAAA-MM-JJ)" })
  @Matches(ISO_DATE, { message: 'receivedAt doit être une date AAAA-MM-JJ' })
  receivedAt!: string;

  @ApiPropertyOptional({ description: 'RETRAIT : id (référentiel) de la compagnie adhérente qui se retire — obligatoire' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  companyId?: string;

  @ApiPropertyOptional({ description: 'ADHESION : raison sociale de la société candidate — obligatoire' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  candidateName?: string;

  @ApiPropertyOptional({ description: "Référence de l'agrément pour la branche automobile" })
  @IsOptional()
  @IsString()
  agrementRef?: string;
}

export class AcceptMembershipRequestDto {
  @ApiPropertyOptional({ description: "Référence d'agrément branche automobile (Art. 30-35) — obligatoire si absente de la demande" })
  @IsOptional()
  @IsString()
  agrementRef?: string;

  @ApiPropertyOptional({ description: 'Id de la compagnie créée au référentiel (POST /referential/companies), si déjà créée' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  companyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  decisionNote?: string;
}

export class RejectMembershipRequestDto {
  @ApiProperty({ description: 'Motif du rejet' })
  @IsString()
  @IsNotEmpty()
  decisionNote!: string;
}

export class MembershipNoteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
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
  @ApiPropertyOptional() decidedAt?: string;
  @ApiPropertyOptional() decidedBy?: string;
  @ApiPropertyOptional() decisionNote?: string;
  @ApiProperty() createdBy!: string;
  @ApiProperty() createdAt!: string;
}
