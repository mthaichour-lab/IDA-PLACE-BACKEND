import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { CreateRecoursDto } from '../recours/dto/recours.dto';
import { ClaimsService } from './claims.service';

/** `POST /recours`, déclaré dans ClaimsModule parce qu'il contrôle le dossier avant de créer le recours (voir `ClaimsService.openRecours`). */
@ApiTags('recours')
@ApiBearerAuth()
@Controller('recours')
@UseGuards(AuthGuard, PrivilegesGuard)
export class RecoursOpeningController {
  constructor(private readonly claims: ClaimsService) {}

  @Post()
  @Privileges('insert')
  @ApiOperation({
    summary:
      "Enregistrement d'un recours (Annexe 2) : dossier existant, de l'assureur direct (`from`), contre la partie tierce déclarée (`to`), éligible IDA, sans recours antérieur (400/409 sinon ; B.7 : `from` = compagnie de l'appelant, sauf rôle place)",
  })
  create(@Body() dto: CreateRecoursDto, @CurrentUser() user: AuthenticatedUser) {
    return this.claims.openRecours(dto, user);
  }
}
