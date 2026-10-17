# ARCHITECTURE — IDA Place Backend

## 1. Principes (C.1-C.4 du dossier technique)

- **Règle d'or** : le back-end n'émet **aucun** HTML/CSS. Le seul point de
  rencontre avec le front est l'**API REST versionnée** (`/api/v1`),
  documentée en OpenAPI (`/api/docs`).
- **Toute règle métier** (éligibilité, score d'appariement, barème,
  tarification, scoring de conformité) vit côté back. Le front ne fait
  qu'afficher les verdicts renvoyés par l'API (C.4).
- **Un module NestJS par domaine** (B.2). Les modules ne partagent que des
  interfaces publiques (services exportés, jamais d'entités internes d'un
  autre module importées directement) — exception : `AuthModule` est
  `@Global()` car `AuthGuard`/`PrivilegesGuard` sont utilisés par
  pratiquement tous les contrôleurs (B.2 : "tous").
- **Contrat d'API stable** : les DTO et routes de `AuthModule`,
  `AdherentsModule`, `ExpertsModule`, `ClaimsModule`, `EligibilityModule`,
  `MatchingModule`, `CockpitModule`, `RealtimeModule` sont figés dans leur
  FORME (un front réel les consomme). Depuis le sprint 3, s'y ajoutent
  `RecoursModule`, `SettlementModule`, `CommissionModule`, `LedgerModule`
  (persisté) — voir §4. Le prochain agent Backend remplace les mocks
  restants par de la vraie logique sans changer les DTO/routes déjà figés.
- **Mode dégradé explicite** : voir README.md. Jamais de triche sécurité.

## 2. Comment ajouter un module

1. Créer `src/<domaine>/<domaine>.module.ts` (+ `.controller.ts`,
   `.service.ts`, `entities/`, `dto/` si le module a un état réel).
2. Appliquer `@UseGuards(AuthGuard, PrivilegesGuard)` sur le contrôleur,
   et `@Privileges('<privilege>')` sur chaque route d'écriture (voir la
   liste des 17 privilèges dans `common/rbac/roles-privileges.ts`).
3. Si le module a des entités MikroORM : `MikroOrmModule.forFeature([...])`
   dans les imports, écrire la migration dans `src/migrations/` (voir
   `Migration20260101000000_Initial.ts` comme modèle), et prévoir un
   repli mémoire (`withDegradedFallback`, voir `adherents.service.ts`).
4. Enregistrer le module dans `src/app.module.ts`.
5. Documenter les endpoints avec les décorateurs `@Api*` de
   `@nestjs/swagger` — c'est la seule documentation d'API du projet.
6. DTO validés avec `class-validator`/`class-transformer` ; pagination via
   `common/dto/pagination.dto.ts` (`{page, total, items}`, 6/p par défaut) ;
   erreurs via `HttpException` (interceptées par
   `NormalizedExceptionFilter` → `{code, message, details}`).

## 3. RBAC (B.7)

- `common/rbac/roles-privileges.ts` : 6 rôles, 17 privilèges, matrice par
  défaut.
- `common/rbac/rbac.service.ts` : matrice mutable au runtime (singleton
  mémoire — à persister en base par le prochain agent Backend, voir
  HANDOFF.md), calcul des privilèges effectifs (rôle + grant/revoke).
  `AUDITEUR_CSA` = toujours lecture seule, quelles que soient les
  dérogations.
- `common/guards/auth.guard.ts` : résout `request.user` via le
  `AuthProvider` actif (`DevAuthProvider` ou `KeycloakStrategy`).
- `common/guards/privileges.guard.ts` : vérifie le(s) privilège(s) requis
  ET bloque toute méthode HTTP mutante pour `AUDITEUR_CSA`, indépendamment
  de la matrice.
- `common/rbac/tenant-scope.ts` : scoping tenant (un `CORRESPONDANT_IDA`/
  `TRESORIER` ne voit que sa compagnie) — appliqué depuis le sprint 3 dans
  `ClaimsService` (`list`/`get`), `RecoursService` (tous les accès) et
  `SettlementService` (`monthly`/`quarter`). **Toujours pas appliqué** dans
  `AdherentsService`/`CommissionService` (voir HANDOFF.md §3 pour l'état
  exact et la question ouverte sur `CommissionModule`).

## 4. État d'avancement module par module

| Module | État | Détail |
|---|---|---|
| `AuthModule` | **RÉEL** | `GET /me`, `DevAuthProvider` fonctionnel, `KeycloakStrategy` = interface + TODO explicite (lève une erreur si activé sans implémentation). |
| `AdherentsModule` | **RÉEL** | Entités MikroORM (`Company`, `Agency`, `Wilaya`), migration, DTO, CRUD, pagination 6/p, repli mémoire si DB absente. |
| `ExpertsModule` | **RÉEL** | Entité `Expert`, DTO, CRUD, pagination. |
| `ClaimsModule` | **RÉEL** (sprint 2) | Entité `Claim` + migration, parsing réel Excel (`exceljs`)/CSV (parseur maison), verdict délégué à `EligibilityModule`, persistance (+ repli mémoire), déclenche l'appariement et émet `claim.ingested`. Voir HANDOFF.md. |
| `EligibilityModule` | **RÉEL** (sprint 2) | Règles B.6 (Art. 3/4/5-6/13/19/28) en fonctions pures testées (`eligibility.rules.spec.ts`), config paramétrable par env. |
| `MatchingModule` | **RÉEL** (sprint 2) | Clé exacte/composite + score pondéré en fonctions pures testées (`matching.scoring.spec.ts`), entité `MatchQueueItem` + migration, décisions persistées (+ repli mémoire), émet `match.updated`. Voir HANDOFF.md. |
| `RecoursModule` | **RÉEL** (sprint 3) | Machine à états + timers conventionnels Art. 10/12/19 (fonctions pures testées, `recours.rules.spec.ts`), persistance + repli mémoire, RBAC par côté (`from`/`to`), scoping tenant, intégration Ledger/Realtime (`recours.timer`). Voir HANDOFF.md. |
| `SettlementModule` | **RÉEL** (sprint 3) | Synthèse mensuelle + compensation trimestrielle (positions bilatérales + net multilatéral) persistées, scoping tenant (B.7). Réutilise `MeteringService` (grille TARIF-2026.01) pour un frais de traitement indicatif. |
| `CommissionModule` | **RÉEL** (sprint 3) | File de conciliation (dérivée des recours à l'état `COMMISSION`), pénalités/sanctions et PV persistés. **Pas de scoping tenant** (question ouverte, voir HANDOFF.md §3). |
| `MonitoringModule` | **RÉEL (partiel)** (sprint 3) | Pondérations B.2 écran 8 inchangées ; délais/qualité données/forclusions/demandes tardives calculés réellement (Claims/Eligibility), silences/oppositions/pénalités toujours `null` explicite (dépendent de Recours/Commission, pas encore branchés malgré leur passage en réel — voir HANDOFF.md). |
| `FraudModule` | **RÉEL** (sprint 3) | 5 détections réelles (doublons, e-constat réutilisé, récurrence véhicule, montants calibrés, incohérences A/B) + journal des actions suspectes, persistés. Sévérités `FAIBLE`/`MOYENNE`/`ELEVEE`. |
| `MeteringModule` | **MOCK (grille réelle)** | Grille tarifaire TARIF-2026.01 = valeurs réelles du dossier (B.8), calcul de facture réel à partir de mesures mockées. `MeteringService` extrait (sprint 3) pour réutilisation par `SettlementModule`. `updateGrid` fusionne par clé (bug de remplacement en bloc corrigé en revue Testeur, sprint 3). Pas de collecte OpenTelemetry. |
| `StatsModule` | **RÉEL (partiel)** (sprint 3) | Déclarations/montants réels par wilaya et activité mensuelle réelle par canal (Claims). "Pour 100k hab." et quelques mesures (Annexes 2, oppositions, indemnisés) omises faute de données plutôt qu'inventées — voir HANDOFF.md. |
| `LedgerModule` | **RÉEL (persisté)** (sprint 3) | Chaînage SHA-256 `hash(n)=f(event,hash(n-1))` désormais append-only en base (était en mémoire), API publique (`GET /ledger`, `GET /ledger/verify`) inchangée. |
| `AdminModule` | **RÉEL** (sprint 3) | `GET/PUT /admin/roles/matrix` réel (fusionne par rôle/privilège depuis la revue Testeur — un payload partiel ne verrouille plus le RBAC). `AdminModule.users` réel : CRUD complet, pagination 6/p, grant/revoke par utilisateur. |
| `DocumentsModule` | **PARTIEL** | Interface `StorageProvider` réelle + `LocalFsStorageProvider` fonctionnel (mode dégradé assumé) ; `S3StorageProvider` réel (sprint 3, SDK S3/MinIO, URL pré-signées ~15 min) ; pas d'intégration Paperless. |
| `RealtimeModule` | **RÉEL (partiel)** (sprint 3) | Gateway Socket.IO (`/realtime`), salons `tenant:place`/`tenant:<companyId>`. Authentification via `handshake.auth.devUser`/`token` (sprint 3 : un navigateur ne peut pas poser d'en-tête personnalisé sur un WebSocket brut — le header `x-dev-user` reste accepté en repli pour les clients non-navigateur). Émet `claim.ingested`, `match.updated`, `recours.timer`. `EventEmitter` interne (`onEvent`) pour que FraudModule observe `match.updated` sans dépendance directe. Toujours en mémoire (pas de pub/sub Redis) — un seul process backend. |
| `AuthModule` (`KeycloakStrategy`) | **RÉEL** (sprint 3) | JWT/JWKS RS256 (cache 10 min), mapping rôle Keycloak → RBAC interne, zero-trust (erreur explicite si mal configuré). ⚠️ Ignore les dérogations grant/revoke par utilisateur (`AdminModule.users`) — câblage non fait pour éviter une dépendance circulaire `AuthModule`↔`AdminModule` (voir HANDOFF.md). |
| Cache Redis | **RÉEL (minimal)** (sprint 3) | `common/cache/` — `REDIS_ENABLED`, repli no-op explicite. Branché en référence sur `GET /cockpit/summary` (TTL 10s). |
| `CockpitModule` *(additionnel)* | **RÉEL** (sprint 2) | `GET /cockpit/summary` — agrège les vraies données de ClaimsModule/MatchingModule (forme inchangée), mis en cache (TTL 10s, sprint 3). Hypothèses documentées dans le fichier (voir HANDOFF.md). |

## 5. Pourquoi un 18ᵉ module (`CockpitModule`) ?

Le dossier technique (B.2) liste 17 modules mais demande explicitement,
en Partie 4 de la mission, un endpoint `/cockpit/summary` "que tu inventes
proprement pour agréger les KPIs de l'écran 1". Plutôt que de le loger
arbitrairement dans un module existant (ce qui aurait mélangé des
responsabilités), un module agrégateur minimal et sans règle métier
propre a été créé. Il ne possède aucune entité propre ; depuis le sprint 2
(voir HANDOFF.md), il appelle réellement `ClaimsService`/`MatchingService`
pour agréger les KPIs de l'écran 1 — toujours sans règle métier qui lui
soit propre.
