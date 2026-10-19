import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { ReferentialPageQueryDto } from '../adherents/dto/company.dto';
import { CreateExpertDto, UpdateExpertDto } from './dto/expert.dto';
import { ExpertsService } from './experts.service';

@ApiTags('referential')
@ApiBearerAuth()
@Controller('referential/experts')
@UseGuards(AuthGuard, PrivilegesGuard)
export class ExpertsController {
  constructor(private readonly service: ExpertsService) {}

  @Get()
  @ApiOperation({ summary: 'Registre des experts de place, paginé (6/p, 100 max) — un rôle compagnie ne voit que les experts qui la servent (SEC-26)' })
  list(@Query() q: ReferentialPageQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.list(q.page, q.pageSize, user);
  }

  @Post()
  @Privileges('refedit')
  @ApiOperation({ summary: "Création d'un expert (SEC-14 : un rôle compagnie ne le rattache qu'à elle-même ; RIB chiffré)" })
  create(@Body() dto: CreateExpertDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.create(dto, user);
  }

  @Put(':id')
  @Privileges('refedit')
  @ApiOperation({ summary: "Mise à jour d'un expert (SEC-14 : un rôle compagnie n'ajoute/retire que son propre rattachement ; statut réservé à la place ; fiche d'un expert partagé modifiable par la place seule)" })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExpertDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.update(id, dto, user);
  }
}
