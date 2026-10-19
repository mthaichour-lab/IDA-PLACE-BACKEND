import { SetMetadata } from '@nestjs/common';

/**
 * Déclarations d'accès explicites — SEC-43 (revue sécurité 2026-10-19).
 *
 * La garde de privilèges est FERMÉE PAR DÉFAUT : un handler HTTP doit porter
 * au moins l'une des déclarations suivantes, sinon `PrivilegesGuard` le
 * refuse (403) et le test de découverte des routes
 * (`test/access-declarations.e2e-spec.ts`) échoue :
 *
 *  - `@Privileges(...)` : un privilège de la matrice rôles × privilèges ;
 *  - `@Roles(...)` : une restriction par rôle (ex. rôles de place) ;
 *  - `@Authenticated()` : tout utilisateur authentifié, le cloisonnement
 *    (compagnie, partie au dossier…) étant fait par le service — à justifier
 *    par un commentaire bref sur la route ;
 *  - `@Public()` : aucune authentification (sondes d'exploitation
 *    uniquement), à justifier également.
 */

export const IS_PUBLIC_KEY = 'access:public';
export const AUTHENTICATED_KEY = 'access:authenticated';

/**
 * Route sans authentification : `AuthGuard` et `PrivilegesGuard` la laissent
 * passer. Réservé aux sondes d'exploitation (`/health/*`) ; toute nouvelle
 * route publique doit être ajoutée à la liste revue du test de découverte.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Accès ouvert à tout utilisateur authentifié (y compris `AUDITEUR_CSA`, qui
 * reste en lecture seule). Le service DOIT appliquer le cloisonnement
 * (`resolveTenantFilter`, `assertCompanyAccess`, partie au dossier…) ou la
 * donnée doit être un référentiel commun de la place.
 */
export const Authenticated = () => SetMetadata(AUTHENTICATED_KEY, true);
