import { Body, Controller, Get, Module, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthModule } from '../auth/auth.module';
import { Privileges } from '../common/decorators/privileges.decorator';
import { PlaceUserDirectory } from '../common/directory/place-user-directory.service';
import { PlaceUserDirectoryModule } from '../common/directory/place-user-directory.module';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { RbacService } from '../common/rbac/rbac.service';
import { ROLES } from '../common/rbac/roles-privileges';
import { CreatePlaceUserDto, ListPlaceUsersQueryDto, UpdatePlaceUserDto } from './dto/place-user.dto';

/**
 * AdminModule — écran 14 "Paramétrage" (super admin), B.2/B.7.
 *
 * `GET/PUT /admin/roles/matrix` RÉEL (inchangé — branché sur `RbacService`).
 * `/admin/users` désormais RÉEL (sprint 3) : CRUD complet (`PlaceUser`,
 * entité + migration), pagination 6/p, compte actif/suspendu, dérogations
 * de privilèges par utilisateur (grant/revoke, B.3 "PlaceUser"). `GET
 * /admin/users` passe d'un tableau brut (ancien mock) à un résultat PAGINÉ
 * (`{page, total, items}`, cohérent avec le reste de l'API, B.11) — c'est
 * un changement de forme assumé et documenté (voir rapport de fin de
 * sprint) : `AdminModule.users` N'ÉTAIT PAS dans la liste des contrats
 * figés (ClaimsModule/MatchingModule/CockpitModule/Auth/Adherents/Experts),
 * et était explicitement "mock, non persisté" jusqu'ici.
 *
 * Entité + service déplacés dans `common/directory/` (`PlaceUserDirectory`,
 * ex-`UsersService`) : `KeycloakStrategy` (AuthModule) consomme désormais
 * les dérogations grant/revoke de ce même miroir applicatif (voir
 * `place-user-directory.service.ts`) sans dépendance inverse
 * `AuthModule` → `AdminModule`.
 *
 * TODO(backend-agent) :
 *  - persister `RolePermMatrix` en base au lieu du singleton mémoire de
 *    `RbacService` (toujours perdu au redémarrage — acceptable en socle) ;
 *  - dashboard des coûts (revenu par inducteur) — brancher sur MeteringModule.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(AuthGuard, PrivilegesGuard)
class AdminController {
  constructor(
    private readonly rbac: RbacService,
    private readonly users: PlaceUserDirectory,
  ) {}

  // Revue sécurité 2026-10-18 (B.7) : `@Privileges('admin')` ajouté — seule
  // route GET de ce contrôleur à en manquer un, elle exposait noms/emails/
  // rôles/compagnies et dérogations de privilèges de TOUS les utilisateurs
  // de la place à n'importe quel utilisateur authentifié.
  @Get('users')
  @Privileges('admin')
  @ApiOperation({ summary: 'Utilisateurs & accès — RÉEL, paginé (6/p)' })
  listUsers(@Query() q: ListPlaceUsersQueryDto) {
    return this.users.list(q.page, q.pageSize);
  }

  @Post('users')
  @Privileges('admin')
  @ApiOperation({ summary: "Création d'un utilisateur (RÉEL, persisté)" })
  createUser(@Body() dto: CreatePlaceUserDto) {
    return this.users.create(dto);
  }

  @Put('users/:id')
  @Privileges('admin')
  @ApiOperation({ summary: "Mise à jour d'un utilisateur — statut actif/suspendu, dérogations grant/revoke (RÉEL, persisté)" })
  updateUser(@Param('id') id: string, @Body() dto: UpdatePlaceUserDto) {
    return this.users.update(id, dto);
  }

  @Get('roles/matrix')
  @ApiOperation({ summary: 'Matrice rôles × 17 privilèges (RÉEL — branché sur le guard effectif)' })
  getMatrix() {
    return { roles: ROLES, matrix: this.rbac.getMatrix() };
  }

  @Put('roles/matrix')
  @Privileges('admin')
  @ApiOperation({ summary: 'Édition de la matrice rôles × privilèges (RÉEL)' })
  putMatrix(@Body() body: { matrix: ReturnType<RbacService['getMatrix']> }) {
    this.rbac.setMatrix(body.matrix);
    return { roles: ROLES, matrix: this.rbac.getMatrix() };
  }
}

@Module({
  imports: [AuthModule, PlaceUserDirectoryModule],
  controllers: [AdminController],
})
export class AdminModule {}
