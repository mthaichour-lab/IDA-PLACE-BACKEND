import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Privileges } from '../common/decorators/privileges.decorator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
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
  @ApiOperation({ summary: "Création d'un expert" })
  create(@Body() dto: CreateExpertDto) {
    return this.service.create(dto);
  }

  @Put(':id')
  @Privileges('refedit')
  @ApiOperation({ summary: "Mise à jour d'un expert" })
  update(@Param('id') id: string, @Body() dto: UpdateExpertDto) {
    return this.service.update(id, dto);
  }
}
