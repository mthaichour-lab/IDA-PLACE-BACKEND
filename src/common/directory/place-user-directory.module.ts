import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { PlaceUserDirectory } from './place-user-directory.service';
import { PlaceUser } from './place-user.entity';

/**
 * PlaceUserDirectoryModule — module d'infrastructure transverse (même
 * principe que `AuthModule`) : propriétaire unique de l'entité `PlaceUser`
 * et du service `PlaceUserDirectory`, importé à la fois par `AdminModule`
 * (CRUD écran 14) et `AuthModule` (`KeycloakStrategy`, lecture des
 * dérogations grant/revoke) SANS que l'un de ces deux modules dépende de
 * l'autre. Voir `place-user-directory.service.ts`.
 */
@Module({
  imports: [MikroOrmModule.forFeature([PlaceUser])],
  providers: [PlaceUserDirectory],
  exports: [PlaceUserDirectory],
})
export class PlaceUserDirectoryModule {}
