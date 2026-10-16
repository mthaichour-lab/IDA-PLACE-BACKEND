import { Body, Controller, Get, Module, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthModule } from '../auth/auth.module';
import { Privileges } from '../common/decorators/privileges.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivilegesGuard } from '../common/guards/privileges.guard';
import { RbacService } from '../common/rbac/rbac.service';
import { ROLES } from '../common/rbac/roles-privileges';

/** Miroir applicatif `PlaceUser` — mock en mémoire (persistance réelle = TODO). */
const MOCK_USERS = [
  { id: 'u-1', name: 'Opérateur Place (dev)', email: 'operateur@finlab.dz', role: 'OPERATEUR_PLACE', active: true, grant: [], revoke: [] },
  { id: 'u-2', name: 'Correspondant CAAT', email: 'correspondant@caat.dz', role: 'CORRESPONDANT_IDA', companyId: 'COMP-0001', active: true, grant: [], revoke: [] },
  { id: 'u-3', name: 'Trésorier SAA', email: 'tresorier@saa.dz', role: 'TRESORIER', companyId: 'COMP-0002', active: false, grant: [], revoke: [] },
];

/**
 * AdminModule — écran 14 "Paramétrage" (super admin), B.2/B.7.
 *
 * La matrice rôles × privilèges (`GET/PUT /admin/roles/matrix`) est RÉELLE
 * (branchée sur `RbacService`, partagée avec `PrivilegesGuard`) : toute
 * modification ici change immédiatement les autorisations effectives de
 * l'API. Les utilisateurs (`/admin/users`) restent mockés.
 *
 * TODO(backend-agent): voir §B.2/B.7 :
 *  - persister `PlaceUser` (entité + migration) au lieu de `MOCK_USERS` ;
 *  - synchroniser avec Keycloak (réconciliation rôle/groupe) une fois
 *    `KeycloakStrategy` implémenté ;
 *  - persister `RolePermMatrix` en base au lieu du singleton mémoire de
 *    `RbacService` (actuellement perdu au redémarrage — acceptable en
 *    socle, pas en production) ;
 *  - dashboard des coûts (revenu par inducteur) — brancher sur MeteringModule.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(AuthGuard, PrivilegesGuard)
class AdminController {
  constructor(private readonly rbac: RbacService) {}

  @Get('users')
  @Privileges('admin')
  @ApiOperation({ summary: 'Utilisateurs & accès (mock)' })
  users() {
    return MOCK_USERS;
  }

  @Post('users')
  @Privileges('admin')
  @ApiOperation({ summary: "Création d'un utilisateur (mock, non persisté)" })
  createUser(@Body() body: Partial<(typeof MOCK_USERS)[number]>) {
    const user = { id: `u-${MOCK_USERS.length + 1}`, active: true, grant: [], revoke: [], ...body } as (typeof MOCK_USERS)[number];
    MOCK_USERS.push(user);
    return user;
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

@Module({ imports: [AuthModule], controllers: [AdminController] })
export class AdminModule {}
