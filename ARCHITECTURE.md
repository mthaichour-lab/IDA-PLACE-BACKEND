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
- **Contrat d'API stable** : les DTO et routes de `ClaimsModule`,
  `MatchingModule` et `CockpitModule` (écrans 1, 2, 3 — priorité de ce
  sprint) sont figés dans leur FORME. Le prochain agent Backend remplace
  les mocks par la vraie logique sans changer les DTO/routes.
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
  `TRESORIER` ne voit que sa compagnie) — **pas encore appliqué dans les
  services existants** (voir HANDOFF.md : `AdherentsService` ne filtre pas
  encore par tenant, à faire quand `ClaimsModule`/`RecoursModule`
  deviendront réels, car eux seuls ont une notion claire de
  "dossier appartenant à une compagnie").

## 4. État d'avancement module par module

| Module | État | Détail |
|---|---|---|
| `AuthModule` | **RÉEL** | `GET /me`, `DevAuthProvider` fonctionnel, `KeycloakStrategy` = interface + TODO explicite (lève une erreur si activé sans implémentation). |
| `AdherentsModule` | **RÉEL** | Entités MikroORM (`Company`, `Agency`, `Wilaya`), migration, DTO, CRUD, pagination 6/p, repli mémoire si DB absente. |
| `ExpertsModule` | **RÉEL** | Entité `Expert`, DTO, CRUD, pagination. |
| `ClaimsModule` | **MOCK (contrat stable)** | `POST /claims/import` renvoie un rapport à la forme finale exacte (47 colonnes, B.4). Pas de persistance ni de parsing réel. |
| `EligibilityModule` | **MOCK minimal** | `GET /eligibility/rules` (lecture). Pas de moteur de règles. |
| `MatchingModule` | **MOCK (contrat stable)** | `GET /matching/queue`, `POST /matching/{id}/decide` avec critères pondérés B.5 déjà visibles dans le DTO. Décisions mutent un tableau en mémoire (perdu au redémarrage). |
| `RecoursModule` | **MOCK minimal** | Registre + transition, pas de timers conventionnels réels. |
| `SettlementModule` | **MOCK minimal** | Synthèse mensuelle + compensation trimestrielle, valeurs calculées à la volée mais non persistées. |
| `CommissionModule` | **MOCK minimal** | File de conciliation, pénalité, PV — pas de persistance. |
| `MonitoringModule` | **MOCK minimal** | Scoring composite avec les VRAIES pondérations B.2 écran 8, valeurs calculées en dur. |
| `FraudModule` | **MOCK minimal** | Cas + journal d'actions, pas de détection réelle. |
| `MeteringModule` | **MOCK (grille réelle)** | Grille tarifaire TARIF-2026.01 = valeurs réelles du dossier (B.8), calcul de facture réel à partir de mesures mockées. Pas de collecte OpenTelemetry. |
| `StatsModule` | **MOCK** | Réutilise le vrai référentiel des 69 wilayas, mesures aléatoires déterministes. |
| `LedgerModule` | **RÉEL (logique de chaînage)** | Chaînage SHA-256 `hash(n)=f(event,hash(n-1))` réellement implémenté et vérifiable (`GET /ledger/verify`), stockage en mémoire (non append-only en base — TODO). |
| `AdminModule` | **PARTIEL** | `GET/PUT /admin/roles/matrix` **RÉEL** (branché sur `RbacService`, effet immédiat sur les autorisations). `GET/POST /admin/users` = mock. |
| `DocumentsModule` | **PARTIEL** | Interface `StorageProvider` réelle + `LocalFsStorageProvider` fonctionnel (mode dégradé assumé) ; `S3StorageProvider` = TODO explicite ; pas d'intégration Paperless. |
| `RealtimeModule` | **SQUELETTE** | Gateway Socket.IO fonctionnel (`/realtime`), un seul événement de démonstration (`metering.tick` périodique). Aucun module métier n'émet encore d'événement réel. |
| `CockpitModule` *(additionnel)* | **MOCK (contrat stable)** | `GET /cockpit/summary` — agrégateur sans logique propre, forme figée pour le front (écran 1). |

## 5. Pourquoi un 18ᵉ module (`CockpitModule`) ?

Le dossier technique (B.2) liste 17 modules mais demande explicitement,
en Partie 4 de la mission, un endpoint `/cockpit/summary` "que tu inventes
proprement pour agréger les KPIs de l'écran 1". Plutôt que de le loger
arbitrairement dans un module existant (ce qui aurait mélangé des
responsabilités), un module agrégateur minimal et sans règle métier
propre a été créé. Il ne possède aucune entité et n'appelle (pour
l'instant) aucun autre service — à corriger par le prochain agent Backend
(voir HANDOFF.md).
