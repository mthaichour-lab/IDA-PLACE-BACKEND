import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsPositive, IsString, Length, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination.dto';

export class ListCommissionCasesQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize: number = DEFAULT_PAGE_SIZE;
}

/** File de conciliation — un recours (RecoursModule) à l'état COMMISSION. */
export class CommissionCaseDto {
  @ApiProperty({ description: 'Id du recours (RecoursModule)' }) id!: string;
  @ApiProperty() claimId!: string;
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty() amount!: number;
  @ApiProperty() commissionAt!: string;
  @ApiProperty({ description: 'Échéance indicative de délibération (commissionAt + délai paramétrable)' }) scheduledAt!: string;
}

export class CreatePenaltyDto {
  @ApiProperty({ description: 'Compagnie visée (code)' })
  @IsString()
  @Length(2, 4)
  targetCompany!: string;

  @ApiProperty()
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiProperty()
  @IsString()
  @Length(1, 2000)
  reason!: string;
}

export class CreateSanctionDto {
  @ApiProperty({ description: 'Compagnie visée (code)' })
  @IsString()
  @Length(2, 4)
  targetCompany!: string;

  @ApiPropertyOptional({ description: 'Montant, si sanction monétaire' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  amount?: number;

  @ApiProperty()
  @IsString()
  @Length(1, 2000)
  reason!: string;
}

export class SanctionViewDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() recoursId?: string;
  @ApiProperty() targetCompany!: string;
  @ApiProperty({ enum: ['PENALITE', 'SANCTION'] }) type!: string;
  @ApiPropertyOptional() amount?: number;
  @ApiProperty() reason!: string;
  @ApiProperty() orderedBy!: string;
  @ApiProperty() orderedAt!: string;
}

export class CreatePvDto {
  @ApiProperty()
  @IsString()
  @Length(1, 2000)
  motif!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 2000)
  decision!: string;

  @ApiProperty({ type: [String], description: 'Noms des signataires (membres de la commission)' })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  signataires!: string[];
}

export class CommissionPvViewDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() recoursId?: string;
  @ApiProperty() motif!: string;
  @ApiProperty() decision!: string;
  @ApiProperty({ type: [String] }) signataires!: string[];
  @ApiProperty() status!: string;
  @ApiProperty() signedAt!: string;
}
