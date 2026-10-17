import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { v4 } from 'uuid';
import { Privilege, Role } from '../rbac/roles-privileges';

/**
 * PlaceUser — B.3 "PlaceUser", écran 14 "Paramétrage" (super admin), B.7.
 * Miroir applicatif des utilisateurs de la place : identité + rôle +
 * dérogations de privilèges (grant/revoke) PAR UTILISATEUR, en plus de la
 * matrice rôle × privilège globale (`RbacService`, déjà réelle).
 *
 * Vit dans `common/directory` (et non `admin`) pour que `AuthModule`
 * (`KeycloakStrategy`) et `AdminModule` (écran 14) puissent tous deux en
 * dépendre sans dépendance inverse `AuthModule` → `AdminModule` — voir
 * `place-user-directory.module.ts`.
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
