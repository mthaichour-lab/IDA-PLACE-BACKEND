import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Privileges } from '../common/decorators/privileges.decorator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { CreateExpertDto, UpdateExpertDto } from './dto/expert.dto';
import { ExpertsService } from './experts.service';

@ApiTags('referential')
@ApiBearerAuth()
@Controller('referential/experts')
@UseGuards(AuthGuard, PrivilegesGuard)
export class ExpertsController {
  constructor(private readonly service: ExpertsService) {}

  @Get()
  @ApiOperation({ summary: 'Registre des experts de place, paginé (6/p)' })
  list(@Query() q: PaginationQueryDto) {
    return this.service.list(q.page, q.pageSize);
  }

  @Post()
  @Privileges('refedit')
  @ApiOperation({ summary: "Création d'un expert (B.7 : la compagnie de l'appelant doit figurer parmi les compagnies servies, sauf rôle place)" })
  create(@Body() dto: CreateExpertDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.create(dto, user);
  }

  @Put(':id')
  @Privileges('refedit')
  @ApiOperation({ summary: "Mise à jour d'un expert (B.7 : réservée aux compagnies déjà servies par cet expert, sauf rôle place)" })
  update(@Param('id') id: string, @Body() dto: UpdateExpertDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.update(id, dto, user);
  }
}
