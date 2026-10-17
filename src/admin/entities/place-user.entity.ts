import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';
import { Privilege, Role } from '../../common/rbac/roles-privileges';

/**
 * PlaceUser — B.3 "PlaceUser", écran 14 "Paramétrage" (super admin), B.7.
 * Miroir applicatif des utilisateurs de la place : identité + rôle +
 * dérogations de privilèges (grant/revoke) PAR UTILISATEUR, en plus de la
 * matrice rôle × privilège globale (`RbacService`, déjà réelle).
 *
 * TODO sprint suivant (voir rapport de fin de sprint) : synchronisation
 * avec Keycloak (réconciliation rôle/groupe) et consommation de ces
 * dérogations par `KeycloakStrategy` au moment de résoudre les privilèges
 * effectifs d'un utilisateur authentifié — non fait ce sprint pour éviter
 * une dépendance inverse AuthModule → AdminModule (ARCHITECTURE.md : modules
 * séparés par interfaces publiques, AuthModule est @Global() et ne doit pas
 * dépendre d'un module applicatif).
 */
@Entity({ tableName: 'place_user' })
export class PlaceUser {
  @PrimaryKey({ type: 'uuid' })
  id: string = v4();

  @Property()
  name!: string;

  @Property({ unique: true })
  email!: string;

  @Property({ length: 40 })
  role!: Role;

  /** Compagnie de rattachement (CORRESPONDANT_IDA/TRESORIER) — absent pour les rôles "place". */
  @Property({ nullable: true })
  companyId?: string;

  @Property()
  active: boolean = true;

  /** Dérogations individuelles — B.7 : privilèges accordés en plus du rôle. */
  @Property({ type: 'text[]' })
  grant: Privilege[] = [];

  /** Dérogations individuelles — B.7 : privilèges retirés malgré le rôle. */
  @Property({ type: 'text[]' })
  revoke: Privilege[] = [];

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date;
}
