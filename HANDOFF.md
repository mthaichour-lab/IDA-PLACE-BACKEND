# HANDOFF — pour le prochain agent Backend

Règle absolue : **ne change pas la forme des DTO/endpoints existants**
(`AuthModule`, `AdherentsModule`, `ExpertsModule`, `ClaimsModule`,
`EligibilityModule`, `MatchingModule`, `CockpitModule`, `RealtimeModule`,
et depuis ce sprint `RecoursModule`, `SettlementModule`,
`CommissionModule`, `LedgerModule`) — implémente la logique métier
**derrière** ces contrats. Rupture de forme → `/api/v2`, jamais silencieuse.

## ⚠️ Particularité de ce sprint : deux implémentations concurrentes réconciliées

Une **session Claude indépendante**, travaillant en parallèle sur ce même
dépôt sans visibilité sur celle-ci, a livré sa propre implémentation
réelle de `RecoursModule`/`SettlementModule`/`CommissionModule` (+ une
suite de tests e2e Supertest, nouvelle dans ce dépôt — `test/*.e2e-spec.ts`,
`npm run test:e2e`) et l'a poussée sur `origin/master` avant que ce sprint
ne pousse le sien. Les deux implémentations ont été **réconciliées** :
celle de la session parallèle a été **conservée** pour ces 3 modules
(déjà poussée, testée, cohérente avec son propre frontend), celle de ce
sprint conservée pour `MonitoringModule`/`FraudModule`/`StatsModule`/
`KeycloakStrategy`/`S3StorageProvider`/`AdminModule.users`/cache Redis.
`LedgerModule` (persistance) est resté celui de ce sprint (non touché par
la session parallèle) — sa migration a été extraite d'un fichier bundlé en
`Migration20260301000001_Ledger.ts` (ne couvre plus que `ledger_entry`).

**Deux failles trouvées et corrigées sur l'implémentation conservée**
(mêmes catégories que celles trouvées sur l'implémentation de ce sprint
avant d'être écartée — revue Product Owner) :
1. **`RecoursService.transition()`** n'avait aucune autorisation par
   action au-delà du `@Privileges('exchange','decide')` du contrôleur :
   n'importe quel `CORRESPONDANT_IDA`/`TRESORIER` pouvait accepter/
   opposer/contester à la place de l'autre compagnie, voire clôturer une
   commission à la place de ses membres. Corrigé (`assertActionAllowed`) :
   accepter/opposer → compagnie `to` ; lever_opposition/contester →
   compagnie `from` ; transmettre_commission → les deux ; clôture
   commission → rôle "place" uniquement. `list()`/`get()`/`counters()`
   étaient aussi sans scoping tenant — corrigé (B.7).
2. **`SettlementService.monthly()`/`quarter()`** n'avaient aucun scoping
   tenant : un `CORRESPONDANT_IDA` voyait le bordereau et la matrice de
   compensation de TOUTES les compagnies concurrentes. Corrigé (même
   principe que `RecoursModule`).

Vérifié manuellement en conditions réelles (voir aussi
`npx jest`/`npm run test:e2e`, tous deux verts hors limite connue §4) :
bon côté accepté, mauvais côté refusé (403), compagnie tierce refusée sur
`GET /recours/:id` (403).

## Réel vs mocké (état après réconciliation)

**Réel** : `AuthModule` (y compris `KeycloakStrategy`), `AdherentsModule`,
`ExpertsModule`, `ClaimsModule`, `EligibilityModule`, `MatchingModule`,
`CockpitModule`, `RealtimeModule`, `RecoursModule`, `SettlementModule`,
`CommissionModule`, `LedgerModule` (persisté), `FraudModule`,
`AdminModule` (roles/matrix + users), `DocumentsModule.S3StorageProvider`,
cache Redis minimal.

**Réel partiel** : `StatsModule` (déclarations/montants/activité réels,
"pour 100k hab." et quelques mesures omises faute de données).

**Mock (grille réelle)** : `MeteringModule`.

## Sprint 3 bis — fait depuis la réconciliation

1. **Monitoring branché sur Recours/Commission** : `silences`/
   `oppositions` (`RecoursService.listAll()`, champ `resolution.kind`) et
   `penalites` (`CommissionService.listSanctions()`) remplacent les 3
   placeholders `NON_DISPONIBLE` — toutes les composantes de
   `MonitoringModule` sont désormais `REEL`. Hypothèses de calcul
   documentées en tête de `monitoring.scoring.ts` (silences = taux de
   recours reçus résolus par silence Art.10 ; oppositions = taux
   d'oppositions reçues non suivies d'effet Art.12 ; pénalités = -20
   points/sanction) — **à valider avec le métier/l'UAR**, non chiffrées
   par le dossier technique.
2. **Scoping tenant de `CommissionModule` tranché par défaut** : appliqué
   (comme Recours/Settlement) plutôt que laissé en transparence totale —
   **à confirmer avec l'UAR** si une transparence de place entre
   adhérents était en fait voulue pour ce module (voir ARCHITECTURE.md §3).
3. **Frontend `/params`, onglet Utilisateurs** : édition actif/suspendu +
   dérogations grant/revoke branchée sur `PUT /admin/users/:id` (réel,
   vérifié en navigateur).

## Todo-list restante, par priorité

### 1. `KeycloakStrategy` ignore les dérogations grant/revoke

Dépendance circulaire `AuthModule`↔`AdminModule` à résoudre proprement
(extraire un `PlaceUserDirectory` partagé) avant toute bascule
`AUTH_PROVIDER=keycloak` réelle. Hors périmètre dev actuel.

### 2. `MatchingService` reste sans scoping tenant

Repéré en passant (ARCHITECTURE.md §3) pendant l'ajout du scoping sur les
autres services — hors périmètre de cette revue, à vérifier avant mise en
production réelle.

### 3. Hypothèses métier à confirmer avec l'UAR/CNA (non tranchées par le dossier technique)

- Délais conventionnels `RecoursModule` (Art.10/12/19) — valeurs par
  variable d'environnement, non chiffrées par le dossier.
- Convention de regroupement mensuel (compagnie `from`, mois d'ENVOI) et
  de compensation trimestrielle (recours `REGLE` uniquement, date de
  règlement ou repli date d'envoi) — voir en-tête de
  `settlement.service.ts`.
- Seuils de gravité anti-fraude, fenêtres de détection (`FraudModule`).
- Hypothèses de calcul `MonitoringModule` silences/oppositions/pénalités
  (voir point 1 ci-dessus).

## Limites connues à signaler au Testeur

- **Pas de PostgreSQL/Redis/MinIO/Keycloak disponibles dans cet
  environnement** — vérification en mode dégradé (repli mémoire)
  uniquement. Migrations jamais exécutées contre une vraie base.
- **`test/claims-import.e2e-spec.ts` — un test échoue systématiquement
  (`ECONNRESET`)**, pas une régression de ce sprint : `PrivilegesGuard`
  rejette (403) avant que `FileInterceptor`/multer n'ait fini de
  consommer le flux multipart (ordre Guards→Interceptors standard de
  NestJS), ce qui coupe la connexion côté client (supertest) avant
  réception propre de la réponse. Comportement HTTP correct côté serveur,
  artefact de test à corriger côté harnais (consommer/drainer le flux, ou
  tester différemment) — pas une correction de code applicatif évidente,
  laissé en l'état par manque de temps ce sprint.

## Vérifications effectuées (après réconciliation + correctifs RBAC)

- `npx tsc --noEmit` : OK. `npx nest build` : OK.
- `npx jest` : **194/194 tests passent**, 17 suites.
- `npm run test:e2e` : **40/41 tests passent** (1 échec = limite connue
  ci-dessus, pas une régression).
- Démarrage réel (`npm run start:dev`, mode dégradé) + scénarios manuels
  `curl` : création de recours, acceptation par le bon côté (succès),
  tentative par le mauvais côté (403), accès par une compagnie tierce
  (403) — tous confirmés après les correctifs RBAC.
