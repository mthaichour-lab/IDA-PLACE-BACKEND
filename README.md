# IDA Place — Backend (NestJS)

API de la plateforme de place **IDA Place** (chambre de compensation pour
l'indemnisation directe des assurés, Algérie). Référence unique :
`/home/user/docs/IDA_Place_Dossier_Technique.md` (Partie B = contrat
back-end, Partie C = répartition des tâches et contrat d'interface).

Voir aussi `ARCHITECTURE.md` (décisions, état d'avancement module par
module) et `HANDOFF.md` (TODO précis pour le prochain agent Backend).

## Stack

NestJS 11 (TypeScript strict) · MikroORM 6 (PostgreSQL) · class-validator ·
Swagger/OpenAPI · Socket.IO (temps réel) · Jest.

## Installation

```bash
npm install
cp .env.example .env
```

## Lancement en développement

```bash
npm run start:dev
```

L'API démarre sur `http://localhost:3001/api/v1`.
Documentation Swagger (OpenAPI) : `http://localhost:3001/api/docs`.

**Aucune infrastructure externe n'est requise pour démarrer** (voir
"Mode dégradé" ci-dessous). Pour disposer de PostgreSQL/Redis en local :

```bash
docker-compose up -d postgres redis
npm run migration:up
npm run seed:wilayas
```

## Authentification en développement

`AUTH_PROVIDER` doit être posé explicitement (aucune valeur par défaut,
démarrage refusé sinon) :

- `keycloak` : `KeycloakStrategy`, intégration OIDC réelle (jeton Bearer
  vérifié par la JWKS du realm, émetteur, audience/`azp`, compte suspendu
  refusé, liaison par `sub`) — seule valeur acceptée en production ;
- `dev` (développement local, refusé si `NODE_ENV=production`) :
  `DevAuthProvider`, qui exige un `DEV_JWT_SECRET` propre au poste ; envoyer
  l'en-tête `x-dev-user` avec soit un nom de rôle, soit un JSON complet.

```bash
curl -H "x-dev-user: OPERATEUR_PLACE" http://localhost:3001/api/v1/me
curl -H "x-dev-user: CORRESPONDANT_IDA" http://localhost:3001/api/v1/me
curl -H "x-dev-user: AUDITEUR_CSA" http://localhost:3001/api/v1/me
```

Rôles disponibles : `OPERATEUR_PLACE`, `ADMIN_UAR`, `MEMBRE_COMMISSION`,
`CORRESPONDANT_IDA`, `TRESORIER`, `AUDITEUR_CSA` (voir `common/rbac`).
Le bouton "Authorize" de Swagger accepte aussi un header `x-dev-user`
(configuré via `@ApiHeader` sur `AuthController`, ou en utilisant l'onglet
"Try it out" avec l'en-tête ajouté manuellement).

⚠️ `x-dev-user` est strictement limité au développement. Voir
`src/auth/strategies/dev-auth.provider.ts` et `keycloak.strategy.ts` ;
configuration Keycloak de production : `docs/DEPLOIEMENT.md` § 6.

Toute route est authentifiée et doit déclarer son accès (`@Privileges`,
`@Roles`, `@Authenticated` ou `@Public`, SEC-43) : les gardes sont globales
et fermées par défaut.

## Mode dégradé (PostgreSQL / Redis / MinIO / Paperless / Keycloak absents)

Ce projet est structuré comme si Keycloak, PostgreSQL (avec réplication),
Redis, MinIO et Paperless étaient réellement intégrés (interfaces,
configuration par variables d'environnement, `docker-compose.yml`), mais
**aucun de ces services n'est requis pour démarrer l'application** dans cet
environnement de développement :

| Service | Comportement si absent | Où |
|---|---|---|
| PostgreSQL | `MikroORM` est initialisé avec `connect: false` (pas de connexion bloquante au boot). Hors production, une erreur de **connexion** identifiée bascule sur un **repository mémoire déterministe** (`withDegradedFallback`), journalisé en `WARN [DEGRADED_MODE]` ; toute autre erreur remonte, et en production la réponse est 503 (SEC-08). | `mikro-orm.config.ts`, `common/interfaces/degraded-mode.ts`, `adherents.service.ts`, `experts.service.ts` |
| Redis | Non branché dans ce socle (pas de cache de lecture implémenté) — `REDIS_ENABLED=false` documente l'intention pour le futur agent Backend. | `.env.example` |
| MinIO/S3 | `S3_ENABLED=false` → `LocalFsStorageProvider` écrit sur disque local (non chiffré, dev uniquement) au lieu de `S3StorageProvider` (non implémenté, lève une erreur explicite si activé sans configuration). | `src/documents/providers/*` |
| Paperless | Non branché (TODO backend-agent). | `src/documents` (TODO dans le module) |
| Keycloak | `AUTH_PROVIDER=dev` → `DevAuthProvider` (en-tête `x-dev-user`, hors production). Avec `AUTH_PROVIDER=keycloak`, une configuration incomplète fait échouer le démarrage et un Keycloak injoignable donne 401 — **jamais de faux admin de repli**. | `src/auth/strategies/*` |

Principe (voir `common/interfaces/degraded-mode.ts`) : l'app démarre
toujours, le repli est explicite et journalisé, et on ne triche jamais sur
la sécurité pour compenser l'absence d'un service.

## Scripts

| Script | Rôle |
|---|---|
| `npm run start:dev` | Démarrage en watch mode |
| `npm run build` | Build (`nest build`, sortie dans `dist/`) |
| `npm run lint` | `tsc --noEmit` |
| `npm test` | Tests unitaires (Jest) |
| `npm run migration:create` / `:up` / `:down` / `:pending` | Migrations MikroORM |
| `npm run seed:wilayas` | Seed des 69 wilayas (idempotent) |

## Structure

Un dossier par module NestJS sous `src/` (voir `ARCHITECTURE.md` pour le
détail et l'état réel/mocké de chacun). Infrastructure transverse dans
`src/common` (RBAC, guards, pagination, erreurs normalisées, mode dégradé).
