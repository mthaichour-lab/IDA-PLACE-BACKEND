# HANDOFF — pour le prochain agent Backend

Règle absolue : **ne change pas la forme des DTO/endpoints existants**
(`AuthModule`, `AdherentsModule`, `ExpertsModule`, `ClaimsModule`,
`EligibilityModule`, `MatchingModule`, `CockpitModule`, `RealtimeModule`,
et depuis ce sprint `RecoursModule`, `SettlementModule`,
`CommissionModule`, `LedgerModule`) — implémente la logique métier
**derrière** ces contrats. Rupture de forme → `/api/v2`, jamais silencieuse.

## ⚠️ 2026-10-17 — Le dossier technique de référence est maintenant disponible

Le document cité partout dans ce code (`IDA_Place_Dossier_Technique.md`,
jusqu'ici introuvable sur cette machine) est maintenant sur le poste de
l'utilisateur : `C:\Users\mthai\Desktop\IDA\IDA_Place_Dossier_Technique.md`
+ un guide utilisateur illustré, `Guide_IDA_Place.docx` (16 captures
d'écran de référence, une par écran). Pagination : ce dépôt était déjà
conforme (6/p partout, `DEFAULT_PAGE_SIZE`) — c'est le **frontend** qui
avait dérivé à 7/p (corrigé côté front, voir son HANDOFF.md). En
revanche plusieurs captures du guide montrent des écrans nettement plus
riches que les DTO actuels (ex. `/stats` : code de barème Art. 14 par
dossier (B01-B11), catégorie de véhicule, baseline IRSAM pour comparer
les délais — aucun de ces champs n'existe sur `Claim` aujourd'hui).
Avant d'étendre un module pour coller à une capture, vérifier d'abord
si le dossier technique fournit la donnée source (sinon : documenter
l'hypothèse ou omettre proprement, ne jamais l'inventer).

### Fait pour rapprocher `/stats` de la capture de référence (2026-10-17)

1. **Bug corrigé — `Recours.settledAt` n'était jamais posé.** `RecoursViewDto`
   déclare ce champ (B.3) mais aucun des 4 chemins qui amènent un recours en
   `REGLE` (`accepter`, `lever_opposition`, `cloturer_commission_favorable`,
   silence Art.10 tacite) ne l'écrivait — `SettlementModule` compensait déjà
   avec un repli sur `requestSentAt` (voir son en-tête), ce qui masquait le
   bug en silence. Corrigé dans `recours.rules.ts` (les 4 chemins posent
   désormais `settledAt`), couvert par 4 assertions ajoutées à
   `recours.rules.spec.ts`. Vérifié en conditions réelles (accepter un
   recours → `settledAt` bien renvoyé par `GET /recours/:id`).
2. **`StatsService.monthly()`** calcule désormais réellement `annexes2`
   (ouvertures de recours), `oppositions` (`opposition.raisedAt`) et
   `indemnises` (recours `REGLE`, par mois de `settledAt`) à partir de
   `RecoursService.listAll()` — ces trois champs dépendaient de
   `RecoursModule`, devenu réel depuis la réconciliation sprint 3.
3. **Nouveau `GET /stats/summary`** : déclarations totales, taux
   d'opposition, montant compensé, délai moyen de règlement — calculés à
   partir de `ClaimsModule`/`RecoursModule`, aucune valeur inventée.
   `StatsModule` n'étant pas dans la liste des contrats figés, cet ajout
   est sans risque de rupture.
4. **Toujours omis** (voir doc de classe `stats.service.ts`) : `pour100k`
   (référentiel démographique absent), comparatif "vs IRSAM" (baseline
   absente des deux documents), codes de barème Art.14 / catégories de
   véhicules / tableau "délais de bout en bout" (champs absents de `Claim`,
   à chiffrer séparément si repris — voir HANDOFF.md frontend pour le
   détail écran par écran).

### Fait pour rapprocher `/quarter` de la capture de référence (2026-10-17)

1. **Nouveau `GET /settlement/quarter/:q/matrix`** : matrice BRUTE
   créancier×débiteur (avant tout netting), pour la carte thermique de
   l'écran 6. `QuarterlySettlementDto` existant ne change pas de forme
   (contrat figé, voir ARCHITECTURE.md §1) — endpoint additif, même
   scoping tenant que `quarter()` (B.7).
2. **Nouveau `GET /settlement/quarter/:q/summary`** : positions brutes,
   après netting bilatéral, après netting multilatéral, réduction des
   flux (%), recours compensés, recours en opposition (hors circuit —
   toutes périodes confondues, pas seulement le trimestre, puisqu'une
   opposition en cours exclut le recours du circuit quel que soit le
   trimestre où elle a été levée). Toutes valeurs réelles, calculées à
   partir de `RecoursService.listAll()` + les fonctions pures déjà
   testées de `settlement.rules.ts` (aucune logique de netting dupliquée).
3. **Toujours omis** (captures du guide, hors périmètre de cette passe) :
   agenda de réunion de commission (date/lieu/ordre du jour — aucune
   entité de planification de réunion n'existe pour la compensation
   trimestrielle, à la différence de `CommissionModule` qui gère les
   dossiers de conciliation individuels, pas des réunions programmées) ;
   diagramme circulaire des flux de règlement (visualisation complexe,
   les données sous-jacentes existent déjà via `net`/`matrix`, juste pas
   le rendu — à faire séparément si repris côté front).

### Fait pour rapprocher `/exchanges` de la capture de référence (2026-10-17)

1. **`GET /recours` accepte un paramètre `q` optionnel** (recherche libre :
   id recours, `claimId` du dossier lié, compagnie `from`/`to`) —
   additif, `ListRecoursQueryDto` existant ne perd aucun champ, les
   clients qui ne l'envoient pas ne voient aucun changement de
   comportement (pas de rupture de forme, ARCHITECTURE.md §1).
2. **Toujours omis** (capture du guide, hors périmètre de cette passe) :
   onglets "Acceptés/silence" vs "Réglés/compensés" du guide (deux sous-
   catégories de `REGLE` dont la distinction métier exacte n'est précisée
   dans aucun des deux documents de référence — plutôt que de deviner une
   règle, les deux tabs utilisables dès aujourd'hui sont `REGLE`/`REJETE`
   eux-mêmes, déjà des états réels de `RECOURS_STATES` mais jusqu'ici
   absents des onglets côté front, voir HANDOFF.md frontend) ; pièces
   jointes Annexe 2/3/4 (aucune intégration `DocumentsModule` pour
   `RecoursModule` — B.2 ne liste que les écrans 2/3/12) ; numéro de
   dossier par compagnie, assuré victime nommé, code de barème par
   dossier (aucun de ces champs n'existe sur `Claim`/`Recours`).

### Fait pour rapprocher `/monthly` et `/commission` de la capture de référence (2026-10-18) — équipe simulée

Premier sprint avec une équipe de 5 agents en parallèle (Tech Lead +
Backend + Frontend + Testeur + Product Owner, worktrees séparés). Le
Product Owner a tranché plusieurs hypothèses AVANT codage — voir son
verdict complet ci-dessous, repris dans les commits.

1. **Bug corrigé dans `monthly()` EXISTANT** (pas seulement une
   hypothèse à trancher, verdict PO explicite) : le regroupement
   mensuel se faisait par date d'ENVOI (`requestSentAt`) au lieu de
   date de RÈGLEMENT (`settledAt`, repli `requestSentAt`) — contredit
   par la capture (colonnes "Réglé le"/"Inséré le" distinctes, recours
   réglés en septembre mais saisis jusqu'à début octobre). `monthly()`
   n'excluait non plus jamais les recours en `OPPOSITION` de ses
   propres totaux par compagnie (RG-06) — corrigé. Changement de
   VALEUR, pas de FORME : `MonthlySettlementDto`/
   `CompanyMonthlySynthesisDto` inchangés.
2. **Nouveaux `GET /settlement/monthly/:period/summary`** (recours
   réglés intégrés, montant, oppositions exclues RG-06, échéance de
   saisie — 5e jour CALENDAIRE de M+1, pas de calendrier de jours
   fériés algériens inventé, le PO déconseille explicitement) **et
   `GET /settlement/monthly/:period/annexe7`** (regroupement par paire
   créancier→débiteur EXACTE, sans netting, contrairement à
   `/settlement/quarter`).
3. **Nouveau `GET /commission/summary`** : dossiers pendants, hors
   délai Art.24 (15 jours), recours jugés fondés (`CommissionCase.
   decision.outcome === 'RECOURS_FONDE'`), oppositions réputées
   fondées Art.12 — **mesure `RecoursModule` indépendante**
   (`resolution.kind === 'OPPOSITION_FONDEE_ART12'`), le PO confirme
   que ce n'est PAS un sous-ensemble des décisions de commission (une
   opposition peut être réputée fondée par simple silence, sans jamais
   passer par un dossier de commission).
4. **Toujours omis** (verdict PO : vraies nouvelles fonctionnalités,
   pas de la donnée déjà là) : pipeline "Avancement du lot" à 5 étapes
   nommées avec échéances (`SettlementClosure` ne modélise qu'une
   clôture simple, pas un workflow multi-étapes) ; onglets "Adhésions &
   retraits" et "Plafond conventionnel" (aucune entité de demande
   d'adhésion/retrait ni de révision de plafond — seul le statut
   `Company.status` existe, pas un workflow de demande).
5. Relabellisation purement visuelle des 3 statuts Commission
   (`A_INSTRUIRE`/`EN_DELIBERE`/`PRONONCE` → "Instruction"/"Audience"/
   "Concilié") confirmée par le PO comme fidèle au nombre et à l'ordre
   des badges de la capture — **côté front uniquement**, zéro
   changement de modèle back.

Vérifié : 231/231 tests unitaires (9 nouveaux cas), 41/41 e2e, tsc/
build sans régression.

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
4. **Scoping tenant de `MatchingService`** : `queue()`/`counters()`/
   `decide()` filtrent désormais par compagnie (même principe que
   Recours/Settlement/Commission — `visibleToUser()`, `resolveTenantFilter`).
   Vérifié manuellement : import d'un accident croisé CAAT/SAA (même
   `numEconstat`, plaques croisées) → les deux compagnies voient la paire
   appariée dans `/matching/queue` et peuvent agir via `/matching/:id/decide`
   (`201`) ; une compagnie tierce (`TALA`) reçoit une file vide, des
   compteurs à zéro, et `403 FORBIDDEN` sur `/decide`.
5. **`KeycloakStrategy` applique désormais les dérogations grant/revoke par
   utilisateur** : dépendance circulaire `AuthModule`↔`AdminModule` résolue
   en extrayant l'entité `PlaceUser` + le service (ex-`UsersService`) dans
   un module transverse neutre, `common/directory/` (`PlaceUserDirectory`,
   `PlaceUserDirectoryModule`) — `AuthModule` ET `AdminModule` l'importent
   tous les deux, sans dépendance de l'un vers l'autre. `KeycloakStrategy`
   résout désormais les dérogations par email du token
   (`findActiveDerogationsByEmail`) et les applique via
   `RbacService.effectivePrivileges(role, grant, revoke)` — EXACTEMENT
   comme `DevAuthProvider`. Un `PlaceUser` introuvable pour cet email (miroir
   pas forcément synchronisé) ou suspendu (`active:false`) applique le rôle
   seul, sans dérogation ni rejet total (Keycloak reste la seule source de
   vérité pour l'authentification elle-même). Vérifié : 212/212 tests
   unitaires (dont les nouveaux cas `keycloak.strategy.spec.ts` — grant
   appliqué, revoke appliqué, email inconnu, compte suspendu) + démarrage
   réel (`AdminModule.users` CRUD testé en navigateur/curl, aucune
   régression). Testable en conditions Keycloak réelles uniquement avec un
   serveur Keycloak (indisponible dans cet environnement) — hors périmètre
   de cette vérification.

## Todo-list restante, par priorité

### 1. Hypothèses métier à confirmer avec l'UAR/CNA (non tranchées par le dossier technique)

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
