import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RouteThrottle } from '../common/throttle/route-throttle';
import { Privileges } from '../common/decorators/privileges.decorator';
import { PlaceUserDirectory } from '../common/directory/place-user-directory.service';
import { PlaceUserDirectoryModule } from '../common/directory/place-user-directory.module';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { RbacService } from '../common/rbac/rbac.service';
import { ROLES, RoleMatrix } from '../common/rbac/roles-privileges';
import { LedgerModule } from '../ledger/ledger.module';
import { LedgerService } from '../ledger/ledger.service';
import { CreatePlaceUserDto, ListPlaceUsersQueryDto, UpdatePlaceUserDto } from './dto/place-user.dto';
import { PutRoleMatrixDto } from './dto/role-matrix.dto';

/** Acteur inscrit au journal scellé. */
function actorOf(user: AuthenticatedUser): string {
  return (user.email || user.id).slice(0, 255);
}

/** Résumé d'une modification d'utilisateur (champs de droits en clair, identité masquée). */
function describeUserPatch(dto: UpdatePlaceUserDto): string {
  const parts: string[] = [];
  if (dto.role !== undefined) parts.push(`role=${dto.role}`);
  if (dto.companyId !== undefined) parts.push(`companyId=${dto.companyId}`);
  if (dto.active !== undefined) parts.push(`active=${dto.active}`);
  if (dto.grant !== undefined) parts.push(`grant=[${dto.grant.join(',')}]`);
  if (dto.revoke !== undefined) parts.push(`revoke=[${dto.revoke.join(',')}]`);
  if (dto.name !== undefined) parts.push('name modifié');
  if (dto.email !== undefined) parts.push('email modifié');
  return parts.join(' ; ') || 'aucun champ';
}

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
 * SEC-25 (revue sécurité 2026-10-19) :
 *  - corps typé `PutRoleMatrixDto` (400 au lieu de 500) ;
 *  - plancher : aucun privilège réservé à la place ne peut être accordé à un
 *    rôle compagnie (matrice ET dérogations `grant` par utilisateur) ;
 *  - chaque modification de la matrice, chaque création/modification
 *    d'utilisateur est JOURNALISÉE dans le journal scellé (avant d'être
 *    appliquée pour la matrice : si le journal est indisponible, la
 *    modification est refusée).
 * SEC-44 : `ParseUUIDPipe` sur `:id`.
 *
 * TODO(backend-agent) :
 *  - persister `RolePermMatrix` en base (toujours perdu au redémarrage) et
 *    exiger la règle des quatre yeux pour la modifier (voir rapport SEC-25) ;
 *  - dashboard des coûts (revenu par inducteur) — brancher sur MeteringModule.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
// SEC-13 : administration des utilisateurs et de la matrice — limite de débit stricte (route-throttle.ts).
@RouteThrottle('ADMIN')
class AdminController {
  constructor(
    private readonly rbac: RbacService,
    private readonly users: PlaceUserDirectory,
    private readonly ledger: LedgerService,
  ) {}

  // Revue sécurité 2026-10-18 (B.7) : `@Privileges('admin')` ajouté — seule
  // route GET de ce contrôleur à en manquer un, elle exposait noms/emails/
  // rôles/compagnies et dérogations de privilèges de TOUS les utilisateurs
  // de la place à n'importe quel utilisateur authentifié.
  @Get('users')
  @Privileges('admin')
  @ApiOperation({ summary: 'Utilisateurs & accès — RÉEL, paginé (6/p)' })
  listUsers(@Query() q: ListPlaceUsersQueryDto) {
    return this.users.list(q.page, q.pageSize, q.scope);
  }

  @Post('users')
  @Privileges('admin')
  @ApiOperation({ summary: "Création d'un utilisateur (RÉEL, persisté)" })
  async createUser(@Body() dto: CreatePlaceUserDto, @CurrentUser() actor: AuthenticatedUser) {
    const created = await this.users.create(dto);
    await this.ledger.append(
      'PLACE_USER_CREATED',
      created.id,
      actorOf(actor),
      `Utilisateur créé : role=${created.role}${created.companyId ? ` ; companyId=${created.companyId}` : ''} ; grant=[${created.grant.join(',')}] ; revoke=[${created.revoke.join(',')}]`,
    );
    return created;
  }

  @Put('users/:id')
  @Privileges('admin')
  @ApiOperation({ summary: "Mise à jour d'un utilisateur — statut actif/suspendu, dérogations grant/revoke (RÉEL, persisté)" })
  async updateUser(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdatePlaceUserDto, @CurrentUser() actor: AuthenticatedUser) {
    const updated = await this.users.update(id, dto);
    await this.ledger.append('PLACE_USER_UPDATED', id, actorOf(actor), `Utilisateur modifié : ${describeUserPatch(dto)}`);
    return updated;
  }

  // Revue sécurité 2026-10-18 : `@Privileges('admin')` ajouté — seule route
  // GET de ce contrôleur à en manquer un, elle exposait la matrice RBAC
  // interne complète à n'importe quel utilisateur authentifié.
  @Get('roles/matrix')
  @Privileges('admin')
  @ApiOperation({ summary: 'Matrice rôles × 17 privilèges (RÉEL — branché sur le guard effectif)' })
  getMatrix() {
    return { roles: ROLES, matrix: this.rbac.getMatrix() };
  }

  @Put('roles/matrix')
  @Privileges('admin')
  @ApiOperation({ summary: 'Édition de la matrice rôles × privilèges (RÉEL)' })
  async putMatrix(@Body() body: PutRoleMatrixDto, @CurrentUser() actor: AuthenticatedUser) {
    // Validation complète (dont le plancher SEC-25) AVANT journalisation et application.
    const changes = this.rbac.previewMatrixChange(body.matrix);
    if (changes.length > 0) {
      await this.ledger.append(
        'RBAC_MATRIX_UPDATED',
        'roles-matrix',
        actorOf(actor),
        `Matrice rôles × privilèges : ${changes.map((c) => `${c.role}.${c.privilege} ${c.from}→${c.to}`).join(' ; ')}`.slice(0, 4000),
      );
      this.rbac.setMatrix(body.matrix as Partial<RoleMatrix>);
    }
    return { roles: ROLES, matrix: this.rbac.getMatrix() };
  }
}

@Module({
  imports: [AuthModule, PlaceUserDirectoryModule, LedgerModule],
  controllers: [AdminController],
})
export class AdminModule {}
