import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';

/** Réponse exacte attendue par le front — C.4 : pilote l'affichage conditionnel. */
class MeResponseDto {
  user!: { id: string; name: string; email: string };
  role!: string;
  privileges!: string[];
  company?: string;
}

@ApiTags('auth')
@ApiBearerAuth()
@ApiHeader({ name: 'x-dev-user', required: false, description: 'DEV ONLY — nom de rôle ou JSON utilisateur (voir DevAuthProvider).' })
@Controller('me')
@UseGuards(AuthGuard)
export class AuthController {
  @Get()
  @ApiOperation({ summary: "Identité courante, rôle et privilèges effectifs (C.4)" })
  @ApiOkResponse({ type: MeResponseDto })
  me(@CurrentUser() user: AuthenticatedUser): MeResponseDto {
    return {
      user: { id: user.id, name: user.name, email: user.email },
      role: user.role,
      privileges: user.privileges,
      company: user.companyId,
    };
  }
}
