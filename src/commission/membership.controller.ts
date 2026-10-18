import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import {
  AcceptMembershipRequestDto,
  CreateMembershipRequestDto,
  ListMembershipRequestsQueryDto,
  MembershipNoteDto,
  RejectMembershipRequestDto,
} from './dto/membership.dto';
import { MembershipService } from './membership.service';

/** Onglet "Adhésions & retraits" de l'écran 7 "Commission" — Chapitre VI, Art. 30-35. */
@ApiTags('commission')
@ApiBearerAuth()
@Controller('commission/membership-requests')
@UseGuards(AuthGuard, PrivilegesGuard)
export class MembershipController {
  constructor(private readonly service: MembershipService) {}

  @Get()
  @ApiOperation({ summary: "Demandes d'adhésion/retrait, paginées, filtrables par type et état (B.7 : un utilisateur compagnie ne voit que celles de SA compagnie)" })
  list(@Query() q: ListMembershipRequestsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.list(q, user);
  }

  @Get(':id')
  @ApiOperation({ summary: "Fiche d'une demande d'adhésion/retrait (B.7 : scopée par compagnie)" })
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.get(id, user);
  }

  @Post()
  @Privileges('membership')
  @ApiOperation({ summary: "Enregistrement d'une demande d'adhésion ou de retrait reçue par l'UAR (Art. 30-35) — date d'effet du retrait calculée" })
  create(@Body() dto: CreateMembershipRequestDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.create(dto, user);
  }

  @Post(':id/accept')
  @Privileges('membership')
  @ApiOperation({ summary: "Acceptation d'une adhésion (RECUE -> ACCEPTEE) — exige la référence d'agrément branche automobile ; ne crée pas la compagnie" })
  accept(@Param('id') id: string, @Body() dto: AcceptMembershipRequestDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.accept(id, dto, user);
  }

  @Post(':id/reject')
  @Privileges('membership')
  @ApiOperation({ summary: "Rejet motivé d'une adhésion (RECUE -> REJETEE)" })
  reject(@Param('id') id: string, @Body() dto: RejectMembershipRequestDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.reject(id, dto, user);
  }

  @Post(':id/effective')
  @Privileges('membership')
  @ApiOperation({ summary: "Constat d'effet d'un retrait (RECUE -> EFFECTIVE), uniquement après la date d'effet — la compagnie passe EN_RETRAIT" })
  effective(@Param('id') id: string, @Body() dto: MembershipNoteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.markEffective(id, dto.decisionNote, user);
  }

  @Post(':id/cancel')
  @Privileges('membership')
  @ApiOperation({ summary: "Annulation d'un retrait à la demande de l'adhérent (RECUE -> ANNULEE)" })
  cancel(@Param('id') id: string, @Body() dto: MembershipNoteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.cancel(id, dto.decisionNote, user);
  }
}
