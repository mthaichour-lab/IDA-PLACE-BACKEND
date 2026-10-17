# HANDOFF — pour le prochain agent Backend

Règle absolue : **ne change pas la forme des DTO/endpoints existants**
(`AuthModule`, `AdherentsModule`, `ExpertsModule`, `ClaimsModule`,
`EligibilityModule`, `MatchingModule`, `CockpitModule`, `RealtimeModule`,
et depuis ce sprint `RecoursModule`, `SettlementModule`,
`CommissionModule`, `LedgerModule`) — implémente la logique métier
**derrière** ces contrats, que le front consomme déjà. Si un besoin impose
vraiment un changement de forme, passe par une nouvelle version d'API
(`/api/v2`, C.4) plutôt qu'une rupture silencieuse sur `/api/v1`.

## Réel vs mocké — résumé rapide (mis à jour, sprint 3)

**Réel** : `AuthModule` (y compris `KeycloakStrategy`, voir limite plus
bas), `AdherentsModule`, `ExpertsModule`, `ClaimsModule`,
`EligibilityModule`, `MatchingModule`, `CockpitModule`, `RealtimeModule`,
`RecoursModule`, `SettlementModule`, `CommissionModule`, `LedgerModule`
(persisté), `FraudModule`, `AdminModule` (roles/matrix **et** users),
`DocumentsModule.S3StorageProvider`, cache Redis minimal.

**Réel partiel** : `MonitoringModule` (4 composantes sur 7 réelles —
silences/oppositions/pénalités `null` explicite, dépendent de
Recours/Commission, voir §1 ci-dessous), `StatsModule` (déclarations/
montants/activité réels, "pour 100k hab." et quelques mesures omises
faute de données).

**Mock (grille réelle)** : `MeteringModule` (grille tarifaire
TARIF-2026.01 réelle, mesures de consommation mockées, pas de collecte
OpenTelemetry).

Voir `ARCHITECTURE.md` §4 pour le détail module par module.

## Ce sprint en bref (sprint 3 — deux agents Backend en parallèle, worktrees séparés)

- **Agent 1** : `RecoursModule`, `SettlementModule`, `CommissionModule`
  réels + persistance `LedgerModule` + tenant-scoping (`ClaimsModule`,
  `RecoursModule`).
- **Agent 2** : `MonitoringModule`/`FraudModule`/`StatsModule` réels
  (partiel) + `KeycloakStrategy` + `S3StorageProvider` + `AdminModule.users`
  + cache Redis.
- **Fusion + revue croisée** (Testeur + Product Owner) sur le résultat
  fusionné : plusieurs bugs de contrat (les deux agents n'ont pas pu se
  voir, chacun dans son worktree) et deux failles métier ont été trouvés
  et **déjà corrigés** par le Tech Lead avant ce commit — voir le détail
  ci-dessous, pas la peine de les re-corriger.

### Corrigé après la revue croisée (sprint 3)

1. **`RecoursService.settle()`** (faille PO) : acceptait un montant
   librement choisi par l'appelant (`dto.amount`) et ne vérifiait que
   "être partie" (pas le bon côté). Corrigé : toujours au montant du
   recours, restreint à la compagnie débitrice (`to`). `SettleRecoursDto`
   est désormais un corps vide.
2. **`SettlementModule` sans scoping tenant** (faille PO) : `GET
   /settlement/monthly/:period` et `GET /settlement/quarter/:q`
   n'étaient filtrés par aucune compagnie — n'importe quel
   `CORRESPONDANT_IDA`/`TRESORIER` voyait les bordereaux et la matrice de
   compensation de TOUTES les compagnies concurrentes. Corrigé (voir
   `scopeQuarterForUser`/le filtre dans `monthly()`).
3. **`MeteringService.updateGrid` / `RbacService.setMatrix`** (bug
   Testeur, risque de verrouillage total) : un `PUT` partiel (un seul
   inducteur, ou un seul rôle) remplaçait TOUT le reste en bloc (`{
   ...old, ...patch }` sur un objet contenant un tableau/sous-objet).
   Corrigé : fusion par clé (`metric`/`role`) plutôt que remplacement en
   bloc. Vérifié manuellement : un `PUT` avec un seul inducteur/rôle ne
   touche plus que lui.
4. **Repli mémoire manquant sur les écritures** (bug Testeur) :
   `ExpertsService.create/update` et
   `AdherentsService.createCompany/updateCompany/createAgency/updateAgency`
   n'avaient aucun `withDegradedFallback` (contrairement aux `list`/`get`)
   — 500 garanti sans PostgreSQL. Corrigé pour les 6 méthodes, avec repli
   sur les tableaux `MEMORY_*` déjà utilisés par `list`.
5. **Authentification WebSocket impossible depuis un vrai navigateur**
   (bug Testeur) : `RealtimeGateway` ne lisait que l'en-tête
   `x-dev-user`, qu'un navigateur ne peut pas poser sur un handshake
   WebSocket brut. Corrigé : lu désormais depuis `handshake.auth.devUser`/
   `token` (transmis par le client Socket.IO), avec repli sur l'en-tête
   réel pour les clients non-navigateur (curl, tests). Vérifié
   manuellement dans un vrai navigateur (voir rapport du Tech Lead) :
   connexion refusée sans `auth`, acceptée avec.
6. **Enum de sévérité fraude incohérent** : back `FAIBLE/MOYEN/ELEVE` vs
   front `FAIBLE/MOYENNE/ELEVEE`. Aligné sur la convention déjà utilisée
   par le front (accord féminin avec "gravité").
7. **Format `companyId` incohérent** dans le mock `AdminModule.users`
   (`COMP-0001`/`COMP-0002` au lieu des codes 4 lettres `CAAT`/`SAA`
   utilisés partout ailleurs) — corrigé dans les données de démonstration.
8. Commentaire périmé dans `monitoring.scoring.ts` (affirmait que
   Recours/Settlement restent des mocks — faux depuis ce même sprint) —
   corrigé.

## Todo-list restante, par priorité

### 1. Brancher Monitoring/Fraud sur Recours/Commission (maintenant réels)

`MonitoringModule` (silences/oppositions/pénalités, toujours `null`) et
dans une moindre mesure `FraudModule` ont été développés dans un worktree
séparé de `RecoursModule`/`CommissionModule` et ne les consomment donc
pas, alors que ces deux derniers sont réels depuis ce même sprint. Prochain
agent : brancher `MonitoringService` sur `RecoursService`/`CommissionService`
(services publics uniquement) pour calculer réellement ces 3 composantes.

### 2. Scoping tenant de `CommissionModule` — décision à prendre

`GET /commission/cases`/`sanctions` n'ont ni `@Privileges` ni filtre
compagnie — délibérément **pas corrigé** ce sprint (voir revue Product
Owner) : pourrait être un choix de transparence de place assumé (les
sanctions commission sont publiques entre adhérents dans ce type de
convention), ou un oubli. **À trancher avec l'UAR** avant de scoper ou de
documenter explicitement comme "transparence voulue".

### 3. `KeycloakStrategy` ignore les dérogations grant/revoke

`src/auth/strategies/keycloak.strategy.ts` appelle
`this.rbac.effectivePrivileges(role, [], [])` — les dérogations
individuelles (`AdminModule.users`, écran Paramétrage) sont donc
silencieusement ignorées une fois basculé en `AUTH_PROVIDER=keycloak`.
Pas corrigé ce sprint : la correction correcte nécessite que
`AuthModule` dépende de `AdminModule`/`UsersService`, alors que
`AdminModule` importe déjà `AuthModule` — dépendance circulaire à
résoudre proprement (extraire un `PlaceUserDirectory` partagé dans
`common/`, par exemple) plutôt qu'un `forwardRef()` hâtif. Hors
périmètre dev actuel (`AUTH_PROVIDER=dev` par défaut) mais à faire avant
toute bascule Keycloak réelle.

### 4. Position bilatérale de compensation trimestrielle — à confirmer avec l'UAR

`SettlementService.quarter()` retient que la compagnie adverse déclarée
doit 100% du montant à la compagnie qui a réglé (pas de barème de
responsabilité partagée). Jugé par le Product Owner comme l'hypothèse la
plus sensible du sprint — voir le détail dans l'historique de revue, à
transmettre à l'UAR/CNA avant toute mise en production réelle.

### 5. Délais conventionnels `RecoursModule` — à confirmer avec l'UAR

Art. 10 (30j)/Art. 12 (15j)/Art. 19 "forclusion globale" (180j,
`RECOURS_ART19_FORCLUSION_DAYS`) sont des valeurs par défaut non chiffrées
par le dossier technique. Le Product Owner note en particulier que ce
"délai de forclusion globale" distinct de celui déjà couvert par
`EligibilityModule` pourrait être un doublon inventé plutôt qu'une vraie
disposition conventionnelle — à vérifier.

### 6. Reste inchangé depuis les sprints précédents

- `RbacService`/`LedgerModule` : la matrice RBAC est toujours un singleton
  mémoire (pas persistée en base) ; `LedgerModule` est persisté (sprint 3)
  mais sa logique de seed reste en mode dégradé par défaut (pas de vraie
  base dans cet environnement, voir §"Limites connues").
- Redis : branché en référence uniquement sur `/cockpit/summary` — à
  étendre à d'autres lectures fréquentes (Stats, Monitoring) si besoin.
- Paperless : non amorcé.

## Limites connues à signaler au Testeur

- **Pas de PostgreSQL/Redis/MinIO/Keycloak disponibles dans cet
  environnement** — toute la vérification de ce sprint a été faite en
  mode dégradé (repli mémoire). Les migrations écrites ce sprint
  (`Migration20260301000000_RecoursSettlementCommissionLedger.ts`,
  `Migration20260301000000_FraudAdmin.ts`) sont type-checkées mais
  **jamais exécutées contre une vraie base** — à valider dès qu'un
  PostgreSQL est disponible.
- Le mapping Keycloak (rôle/`company_id`) n'a été vérifié qu'avec des
  JWT de test signés en mémoire (JWKS mocké) — jamais contre un vrai
  realm Keycloak.
- `S3StorageProvider` n'a été vérifié que par lecture de code — jamais
  testé contre un vrai S3/MinIO (`S3_ENABLED=false` par défaut).

## Vérifications effectuées dans ce sprint (après fusion + corrections)

- `npx tsc --noEmit` : OK, aucune erreur.
- `npx nest build` : OK.
- `npx jest` : **128/128 tests passent**, 12 suites.
- Démarrage réel (`npm run start:dev`, mode dégradé, sans
  PostgreSQL/Redis/MinIO/Keycloak) + scénarios manuels `curl` après
  correctifs :
  - `POST /recours` → `EN_ATTENTE` ; `POST /recours/:id/settle` par la
    compagnie créditrice (mauvais côté) → 403 ; par la compagnie
    débitrice avant l'état requis → 409 (garde-fous confirmés).
  - `PUT /pricing/grid` avec un seul inducteur → les 11 autres inchangés
    (régression confirmée corrigée) ; `PUT /admin/roles/matrix` avec un
    seul rôle → les 5 autres rôles gardent leurs privilèges.
  - `GET /settlement/monthly/:period` et `/quarter/:q` : pas d'erreur
    pour un rôle scopé compagnie sans dossier sur la période (liste/
    positions vides, cohérent).
  - `GET /admin/users` → `companyId` au format `CAAT`/`SAA`.
  - Connexion WebSocket `/realtime` vérifiée **dans un vrai navigateur**
    (via le panneau de prévisualisation) : refusée sans `auth.devUser`,
    acceptée avec (disconnect serveur confirmé dans le premier cas).
