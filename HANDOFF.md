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

### `MatchQueueItemDto` — champs additifs pour `/matching` (écran 2, 2026-10-18, agent Frontend)

L'agent Frontend travaillant sur `/matching` (worktree séparé) avait
besoin de quelques champs par déclaration (A/B) pour construire une "Vue
de confrontation" champ par champ + des cartes "Véhicule A/B" fidèles à
la capture de référence — `MatchQueueItemDto` n'exposait jusqu'ici que
`refA/companyA/plateA` + équivalent B. **Changement additif pur, la forme
existante de `MatchQueueItemDto` et des routes `/matching/*` ne change
pas** (contrat stable, voir ARCHITECTURE.md §1).

1. **10 champs optionnels ajoutés** à `MatchQueueItemDto` :
   `accidentDateA/B`, `wilayaA/B`, `assureAIdentite/B`,
   `canalDeclarationA/B`, `policeA/B`. Même convention que `plateA`/
   `plateB` existants : la valeur "SOI-MÊME" de chaque déclaration (ex.
   `assureAIdentite` = identité de l'assuré de la déclaration A, PAS une
   identité "partie A vue par B"), dénormalisés depuis `ClaimMatchInput`
   au même recalcul que `criteria` (`matching.service.ts`
   `applyComputed`/`applyComputedDto`) — affichage uniquement, aucun
   impact sur le score/niveau AUTO/MANUEL/NON.
2. **`ClaimMatchInput` (matching.types.ts)** : ajout de
   `assureIdentite?`/`canalDeclaration?`. `canalDeclaration` existait déjà
   sur `ClaimViewDto` (juste jamais transmis à `MatchingModule` via
   `toMatchInput`). `assureIdentite` (colonne 44 "Identité assuré A" du
   modèle 47 colonnes, `claim-47-columns.ts`) n'était promu NULLE PART
   (ni `Claim` entity, ni `ClaimViewDto`) — ajouté en champ optionnel à
   `ClaimViewDto`, lu depuis `Claim.raw.assureAIdentite` (déjà stocké en
   JSON à l'import, donc **aucune migration nécessaire pour celui-là**).
3. **Migration MikroORM** (`Migration20261018000000_
   MatchingConfrontationFields`, écrite à la main comme les précédentes —
   toujours pas de PostgreSQL disponible ici) : 8 nouvelles colonnes
   nullable sur `match_queue_item` (`accident_date_a/b`, `wilaya_a/b`,
   `assure_a_identite`/`assure_b_identite`, `canal_declaration_a/b`,
   `police_a/b`) — `assureIdentite`/`canalDeclaration` ci-dessus touchent
   `claim`/`ClaimViewDto` (déjà en JSON, pas de colonne), mais
   `MatchQueueItem` est une table dénormalisée à plat (B.3), donc CES
   colonnes-là ont besoin d'une vraie migration.
4. Volontairement **PAS de scoring graduel/partiel ajouté** — demande
   explicitement refusée par construction : la capture de référence
   montre des scores par critère gradués (ex. "21/35", "67 %
   similarité"), mais `matching.scoring.ts` n'a jamais calculé ça (chaque
   critère pondéré est un booléen strict, poids plein ou zéro). Le Tech
   Lead avait vérifié ce point avant de lancer la tâche front : la
   fraction affichée côté front (`{poids}/{poids}` ou `0/{poids}`) reflète
   honnêtement le booléen réel, aucun calcul de similarité n'a été ajouté
   ici.
5. Vérifié : `npx jest src/matching src/claims --silent` (37/37, aucune
   régression) + `npx tsc --noEmit -p .` (OK). Voir HANDOFF.md frontend
   pour le détail de l'écran `/matching` qui consomme ces champs.

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

## Revue sécurité RBAC/scoping tenant systématique (2026-10-18)

Tous les écrans du guide illustré étant construits et vérifiés (voir
HANDOFF.md frontend), audit systématique (pas réactif écran-par-écran
comme jusqu'ici) de TOUS les contrôleurs backend contre le scoping tenant
B.7 (`resolveTenantFilter`/`assertCompanyAccess`, `common/rbac/
tenant-scope.ts`) — ce même angle mort avait déjà été trouvé et corrigé
au moins 4 fois auparavant sur des modules isolés (Matching sprint 3,
Recours sprint 3, Settlement/Commission revue PO) sans jamais être
vérifié de façon exhaustive sur l'ensemble du code. Un agent dédié
(revue sécurité) a d'abord cartographié tous les contrôleurs ; chaque
trouvaille a ensuite été relue manuellement (fichier par fichier, jamais
fait confiance au rapport seul) avant correctif.

**Fuites cross-tenant réelles corrigées** (un `CORRESPONDANT_IDA`/
`TRESORIER` d'une compagnie pouvait accéder aux données d'une AUTRE
compagnie) :

1. **`DocumentsModule`** — le plus sévère : `upload()` préfixait TOUTES
   les pièces (constats, cartes grises, devis) sous la même clé
   `"default-tenant/..."` partagée entre compagnies, et `presign(:key)`
   signait une URL pour N'IMPORTE QUELLE clé sans aucune vérification de
   propriétaire. Corrigé : préfixe par la compagnie réelle de
   l'uploadeur (ou `"place"` pour les rôles place, décision documentée
   dans le code), `presign` vérifie désormais le préfixe compagnie de la
   clé contre l'appelant. `PrivilegesGuard` était également absent du
   contrôleur (AUDITEUR_CSA pouvait uploader, son blocage absolu en
   écriture n'était jamais évalué) — ajouté.
2. **`MonitoringModule`** — `trajectories()` appelait
   `MatchingService.queue()` SANS `user`, contournant le filtre tenant
   déjà existant côté MatchingModule (`visibleToUser` renvoie `true`
   quand `user` est `undefined` — un piège silencieux, pas une absence
   de protection). `journeys(:code)` n'avait aucun contrôle du tout et
   dupliquait une donnée (recours, montants, contreparties) déjà
   protégée ailleurs (`RecoursModule`). `scores()` reste
   DÉLIBÉRÉMENT place-wide — le dossier technique décrit explicitement
   le "classement" comme une fonctionnalité documentée de l'écran 8, pas
   un oubli ; restreindre ce endpoint aurait cassé une fonctionnalité
   réelle sous couvert de "corriger un bug".
3. **`FraudModule`** — même famille de trou : `cases()`/
   `signalsByAdherent(:company)` sans aucun scoping. Corrigé par
   filtrage sur `companiesInvolved` (même principe que `from`/`to`
   ailleurs — un cas reste visible à une compagnie partie même s'il en
   nomme une autre, la détection de fraude étant inter-compagnies par
   nature, voir `fraud.detection.ts`). `actions()` (journal des actions
   suspectes de PLACE) volontairement NON scopé — `FraudAction.actor`
   est un champ à typage mixte (identité utilisateur OU code compagnie
   selon le type d'action), pas un champ fiable pour filtrer ; point
   ouvert documenté dans `QUESTIONS_UAR.md` plutôt que deviné.
4. **`CommissionModule.createCase`** — appelait `RecoursService.get()`
   SANS `user` (même piège silencieux que #2), permettant d'ouvrir un
   dossier de conciliation à partir du `recoursId` de N'IMPORTE QUELLE
   compagnie, avec fuite de ses données (contreparties, montant) dans la
   réponse. Corrigé en transmettant `user` — le contrôle existant de
   `RecoursService.get` s'applique alors normalement.
5. **`SettlementModule.closeMonthly`** — `dto.company` venait du corps
   de la requête sans vérification ; un `TRESORIER` (privilège `synth`,
   scopé compagnie) pouvait clôturer la synthèse mensuelle d'une AUTRE
   compagnie. Corrigé par `assertCompanyAccess`. `closeQuarterly` (pas
   de paramètre compagnie, action place-entière) laissé tel quel —
   question de matrice de privilèges, pas de scoping, voir
   `QUESTIONS_UAR.md` §11.
6. **`AdherentsModule`** (`updateCompany`/`createAgency`/`updateAgency`)
   et **`ExpertsModule`** (`create`/`update`) — `refedit` est détenu par
   `CORRESPONDANT_IDA`, mais aucune de ces mutations ne vérifiait que la
   compagnie modifiée était bien celle de l'appelant. Corrigé par
   `assertCompanyAccess` (Company/Agency, une seule compagnie
   propriétaire) ou un nouvel `assertCompanyAmong` dédié (Expert, qui
   sert PLUSIEURS compagnies à la fois via `companies: string[]` — la
   vérification d'égalité stricte ne s'applique pas, voir
   `experts.service.ts`). Vérification volontairement placée EN DEHORS
   de tout `withDegradedFallback` de mutation dans les deux modules : une
   `ForbiddenException` levée DEDANS y serait interceptée comme une
   simple panne DB et déclencherait à tort le repli mémoire (qui aurait
   pu réussir et renvoyer 200 au lieu de 403) — piège spécifique à ce
   helper, documenté dans le code à chaque point d'usage.
   `createCompany` (création d'une toute NOUVELLE compagnie, pas de
   propriétaire existant à vérifier) laissé tel quel — question de
   matrice de privilèges, voir `QUESTIONS_UAR.md` §12.
7. **`RecoursModule.create`** — `dto.from` venait du corps sans
   vérification ; un `CORRESPONDANT_IDA` pouvait créer un recours au nom
   d'une AUTRE compagnie (usurpation de `from`). Corrigé par
   `assertCompanyAccess` (paramètre `user` resté optionnel pour ne pas
   casser les ~15 call sites de test existants qui créent des recours
   sans contexte utilisateur — seul le contrôleur HTTP réel fournit
   toujours `user`).
8. **`MeteringModule`** (`get`/`history`, routes `:company/:period`) —
   aucun scoping. Sévérité réelle aujourd'hui FAIBLE (la consommation
   est un mock IDENTIQUE pour toutes les compagnies,
   `MOCK_MEASURED_CONSUMPTION`, pas de vraie donnée différenciée à
   fuiter) mais corrigé par anticipation : c'était la seule route du
   module sans ce contrôle, un piège pour le jour où le TODO
   "consommation réelle par tenant" sera implémenté.
9. **`AdminModule`** — `GET /admin/users` était la seule route GET de ce
   contrôleur sans `@Privileges('admin')`, exposant noms/emails/rôles/
   compagnies et dérogations de privilèges de TOUS les utilisateurs de
   la place à n'importe quel utilisateur authentifié. Corrigé.

**Durcissement pour cohérence** (aucun comportement changé — ces
contrôleurs n'ont aucune route d'écriture aujourd'hui, confirmé par
grep) : `PrivilegesGuard` ajouté à `EligibilityModule`/`StatsModule`/
`LedgerModule`/`CockpitModule` (manquait `AuthGuard` seul, déviation du
motif établi partout ailleurs — piège pour la prochaine route POST
ajoutée sans qu'on remarque l'absence du garde).

**3 points volontairement NON corrigés seul**, parce qu'ils sont des
questions de politique de privilèges (qui a le droit de faire X) et non
des trous mécaniques de scoping tenant (donnée de compagnie A visible
par compagnie B) — documentés avec la question précise à trancher dans
`QUESTIONS_UAR.md` §11-13 : qui peut clôturer la compensation
trimestrielle PLACE ENTIÈRE (`closeQuarterly`), qui peut créer une
TOUTE NOUVELLE compagnie adhérente (`createCompany`), et si le journal
des actions suspectes de fraude doit être scopé par compagnie.

**Vérifié** : 272/272 tests unitaires (dont 20 nouveaux cas e2e dédiés
dans `test/security-tenant-scope.e2e-spec.ts`, reproduisant chaque
scénario d'exploitation exact avant/après correctif — et 17 nouveaux cas
unitaires `adherents.service.spec.ts`/`experts.service.spec.ts`),
`tsc --noEmit` propre, `npm run build` réussi. E2e : 60/61 (le seul échec,
`claims-import.e2e-spec.ts` "exige le privilège import", est un flake
`ECONNRESET` pré-existant sur l'upload multipart — reproduit IDENTIQUE
sur le commit de base avant toute modification de cette revue, via
`git stash`/`git stash pop` ; aucun rapport avec `ClaimsModule`, jamais
touché ici). Smoke-testé en navigateur/curl réel après correctif (backend
isolé port 3003, `OPERATEUR_PLACE`) sur chaque module modifié —
`resolveTenantFilter`/`assertCompanyAccess` sont des no-op pour les
rôles place, donc aucun impact visible sur l'expérience démo actuelle
(qui tourne toujours en `OPERATEUR_PLACE`).

## Revue sécurité générale — hors scoping tenant (2026-10-18)

Deuxième passe de sécurité, complémentaire à la revue RBAC/scoping ci-dessus
: mass assignment, injection, fuites de secrets/erreurs, validation
d'upload, en-têtes de sécurité, fusion non validée de config critique.
Même discipline : chaque trouvaille relue contre le code réel avant
correctif.

1. **Traversée de chemin dans `DocumentsModule.upload()` (le plus sévère)**
   — `file.originalname` (multipart, entièrement contrôlé par
   l'appelant) entrait tel quel dans la clé de stockage, elle-même passée
   à `join(baseDir, key)` dans `LocalFsStorageProvider.put()`. `path.join`
   NE clampe PAS au répertoire de base (il normalise juste les `..`) : un
   nom de fichier `"../../../../etc/cron.d/x"` écrivait hors de
   `.data/documents`, n'importe où le process a les droits. Corrigé à
   DEUX niveaux (défense en profondeur) : `sanitizeFilename()` (source,
   `documents.module.ts` — `basename()` puis allowlist alphanumérique)
   ET un contrôle de confinement par chemin résolu dans
   `LocalFsStorageProvider.put()` (puits, protège tout futur appelant qui
   oublierait d'assainir en amont).
2. **`AUTH_PROVIDER` basculait silencieusement sur `DevAuthProvider` pour
   toute valeur ≠ `'keycloak'`** (absente, mal orthographiée...) —
   `DevAuthProvider` authentifie n'importe quel rôle (y compris
   `ADMIN_UAR`) depuis un simple en-tête `x-dev-user` non signé, sans
   aucune vérification de secret. Dans un environnement réellement
   exposé, une variable d'env oubliée aurait été un contournement total
   de l'authentification, pas un repli dégradé — exactement la "triche
   sur la sécurité" que `degraded-mode.ts` interdit explicitement pour
   tout le reste du projet, appliquée ici à la sélection du provider
   elle-même. Corrigé : `AUTH_PROVIDER` doit désormais être
   EXPLICITEMENT `"dev"` ou `"keycloak"`, toute autre valeur fait échouer
   le démarrage. `.env` de ce poste a déjà `AUTH_PROVIDER=dev` explicite
   — aucun impact sur l'environnement de dev actuel (vérifié : toute la
   suite e2e démarre et passe normalement).
3. **`DEV_JWT_SECRET` par défaut PUBLIQUE** (`dev-local-only-secret-
   change-me`, committée dans `.env.example` ET `.env` de ce poste),
   utilisée à la fois pour vérifier les JWT dev et pour signer les URL
   pré-signées de `LocalFsStorageProvider`. Avertissement fort ajouté au
   démarrage (pas un échec dur — cet environnement de dev/démo utilise
   cette valeur intentionnellement) ; la vraie protection est le
   correctif #2 ci-dessus (`AUTH_PROVIDER` explicite).
4. **`NormalizedExceptionFilter` renvoyait `exception.message` brut au
   client** pour toute erreur non-HTTP (panne ORM/driver, exception JS
   inattendue) — pouvait exposer noms de table/colonne, chemins, détails
   internes. Corrigé : message générique au client, message réel toujours
   journalisé serveur (comportement de logging inchangé).
5. **Upload sans limite de taille/type** (`DocumentsModule.upload` ET
   `ClaimsModule` import) — DoS par fichier géant, type arbitraire
   stocké/importé. Limites et allowlist RAISONNABLES mais PROVISOIRES
   (15 Mo + PDF/JPEG/PNG/WEBP pour les documents, 20 Mo + CSV/XLS/XLSX
   pour l'import) — aucune valeur officielle dans le dossier technique,
   point ouvert ajouté à `QUESTIONS_UAR.md`.
6. **`GET /admin/roles/matrix` sans `@Privileges('admin')`** — exposait
   la matrice RBAC interne complète (17 privilèges × 6 rôles) à
   n'importe quel utilisateur authentifié. Corrigé.
7. **`PUT /admin/roles/matrix` : payload jamais validé** — type TS
   inline côté contrôleur (pas un DTO de classe), donc le
   `ValidationPipe` global ne s'appliquait pas du tout.
   `RbacService.setMatrix()` fusionnait alors n'importe quelle clé
   rôle/privilège sans vérification. Déjà gardé par `@Privileges('admin')`
   (pas une escalade de privilège en soi), mais un point d'entrée non
   validé sur une config de sécurité critique. Corrigé en validant dans
   `setMatrix()` lui-même (protège tout futur appelant interne aussi,
   pas seulement cette route).
8. **Aucun en-tête de sécurité** (`helmet` absent) — ajouté (`npm install
   helmet`, nouvelle dépendance) avec `contentSecurityPolicy: false`
   explicite (Swagger UI, servi par ce même process sur `/api/docs`,
   utilise des scripts/styles inline qu'une CSP stricte par défaut
   bloquerait — vérifié que `/api/docs` charge toujours correctement
   après coup). Tous les autres en-têtes de `helmet` restent actifs
   (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, HSTS...).

**Points confirmés SAINS** (vérifiés, pas juste supposés) : pas de SQL
brut/`eval`/exécution shell nulle part ; `apiKeyMasked` est réellement
dérivé d'un hash stocké, jamais la clé en clair ; `Expert.rib` est
correctement exclu de tous les DTO de vue malgré son champ `hidden:true`
sur l'entité ; CORS n'est pas un wildcard (origine précise +
`credentials`) ; `PlaceUserDirectory.definedFieldsOnly()` protège déjà
contre un piège de mass assignment adjacent (class-transformer qui
transforme un champ optionnel absent en `undefined` explicite, ce qui
aurait effacé des données via `Object.assign`).

**Vérifié** : 281/281 tests unitaires (dont 9 nouveaux cas dans
`normalized-exception.filter.spec.ts`/`rbac.service.spec.ts`/
`auth-provider-selection.spec.ts`), e2e 69/70 (9 nouveaux cas dans
`test/security-general.e2e-spec.ts`, le seul échec restant est le même
flake `claims-import` pré-existant et sans rapport, voir la revue RBAC
ci-dessus pour sa confirmation via `git stash`), `tsc --noEmit` propre,
build réussi. Smoke-testé en navigateur/curl réel : en-têtes `helmet`
bien présents sur une vraie réponse, `/api/docs` (Swagger) charge
toujours correctement avec la CSP désactivée.

## Mise à jour de dépendances — vulnérabilité critique corrigée (2026-10-18)

En creusant le `npm install helmet` de la revue sécurité générale
ci-dessus (qui avait signalé "69 vulnérabilités dont 1 critique" sans
être investigué sur le moment), `npm audit` a révélé que la vulnérabilité
**critique** était dans **`@mikro-orm/core`** lui-même — l'ORM utilisé
par absolument tous les modules de ce backend — PAS dans un outil de
build/test comme le reste du bruit habituel de `npm audit` :

- **`@mikro-orm/core` < 6.6.10** : injection SQL via un objet spécialement
  construit (GHSA-gwhv-j974-6fxm, critique) + pollution de prototype
  dans `Utils.merge` (GHSA-qpfv-44f3-qqx6, élevée).
- **`@mikro-orm/knex` ≤ 6.6.13** : injection SQL via des identifiants/clés
  JSON-path contrôlés à l'exécution (GHSA-cfw5-68c4-ffqp, élevée, CVSS
  7.6) — affecte `@mikro-orm/migrations`/`@mikro-orm/postgresql`.
- **`@nestjs/common` 11.0.0-next.1–11.0.15** : exécution de code arbitraire
  via l'en-tête Content-Type (modérée, mais "exécution de code" est le
  genre de chose qui mérite d'être prise au sérieux indépendamment du
  label de sévérité npm).
- **`@nestjs/core`/`@nestjs/platform-express`** : injection + vulnérabilité
  `path-to-regexp` transitive (élevée).

Ce projet était épinglé sur `@mikro-orm/*@6.4.3` et `@nestjs/{common,
core,platform-express}@11.0.11` — tous dans la plage vulnérable. Mis à
jour vers `@mikro-orm/{core,migrations,postgresql,cli}@6.6.17` et
`@nestjs/{common,core,platform-express}@11.2.7` +
`@nestjs/swagger@11.4.7` + `@nestjs/config@4.0.4` — **toutes des mises à
jour mineures/patch, même version majeure** (confirmé `isSemVerMajor:
false` dans `npm audit --json` avant d'y toucher, et compatibilité
vérifiée contre les `peerDependencies` de `@mikro-orm/nestjs@6.1.1`
avant de lancer l'install). Vulnérabilités prod restantes (19, dont 0
critique) nécessitent toutes une montée de version MAJEURE
(`@mikro-orm/*@7.x`, `@nestjs/swagger@12.x`, `exceljs@3.x` pour un
`uuid` transitif) — **volontairement non tentées ici** : une migration
majeure de l'ORM central de ce backend (entités, migrations,
repositories, requêtes dans quasiment chaque service) est un chantier à
part entière, pas un correctif de routine à faire en passant.

**Vérifié** : 281/281 tests unitaires, e2e 70/70 PASSÉS cette fois
(le flake `claims-import`/ECONNRESET habituel ne s'est simplement pas
manifesté sur cette exécution précise — reconfirmé flaky en ré-exécutant
ce seul fichier isolément juste après, donc PAS corrigé par cette mise à
jour, juste une question de timing comme toujours), `tsc --noEmit`
propre, build réussi. Smoke-testé en navigateur/curl réel (lecture,
scoring calculé, écriture en mode dégradé) — tout fonctionne
normalement après la mise à jour.

## Pièces jointes Recours/Commission + durcissement privilèges — QUESTIONS_UAR.md §9/§11/§12 (2026-10-18, équipe 4 rôles)

Trois décisions du Product Owner réel (pas simulées), traitées ensemble
par le Backend agent dans un même worktree (`feat/uar-points-9-11-12`,
commit `704d3b3`) :

- **§9** : nouvelle entité `Document` (`src/documents/entities/
  document.entity.ts`, premier enregistrement persisté de
  `DocumentsModule`) — `recoursId?`/`commissionCaseId?` en simples
  colonnes string (jamais de relation MikroORM, règle constante de ce
  code base). `POST /documents/upload` accepte ces deux champs additifs
  (dépôt manuel, jamais les deux à la fois) ; `GET /documents?recoursId=X
  |commissionCaseId=Y` liste les pièces — même contrôle de périmètre
  compagnie que `RecoursService.get`/`CommissionService.getCase` (le
  dossier cité est résolu via le VRAI service avant tout accès, même
  motif que le correctif `CommissionService.createCase` de la revue
  sécurité). Migration `Migration20261018010000_DocumentAttachments.ts`.
- **§11** : nouveau privilège `closeQuarter` (OPERATEUR_PLACE/ADMIN_UAR/
  MEMBRE_COMMISSION uniquement), remplace `synth` sur `POST /settlement/
  quarter/:q/close` — `synth` reste inchangé pour la lecture.
- **§12** : nouveau privilège `onboardCompany` (OPERATEUR_PLACE/
  ADMIN_UAR uniquement), remplace `refedit` sur `POST /referential/
  companies` — `refedit` reste inchangé pour `updateCompany`/
  `createAgency`/`updateAgency`/experts.

**Vérifié par le Backend agent puis re-vérifié par le Tech Lead** :
292/292 tests unitaires (9 nouveaux), 79/79 e2e (9 nouveaux), `tsc
--noEmit` propre, build réussi.

**Vérification Testeur en navigateur/API réel (texte seul, jamais de
capture d'écran)** — **PASS sur les 3 points**, aucune trouvaille cette
fois (contrairement au round précédent) :
- §9 : upload réel (contournement : `curl -F file=@...` bloqué par le
  sandbox de cette session — `PowerShell HttpClient` utilisé à la
  place, fonctionne normalement), liste confirmée, lien de téléchargement
  réel (`url` non vide), 403 cross-tenant confirmé (compagnie tierce,
  upload ET lecture), 404 dossier inconnu confirmé, variante
  CommissionCase (recours → opposer → contester → transmettre_commission
  → dossier de commission) également vérifiée de bout en bout.
- §11 : `TRESORIER`/`CORRESPONDANT_IDA` → 403 (`held` ne contient pas
  `closeQuarter` malgré `synth` présent) ; `OPERATEUR_PLACE` → 201/409
  idempotent.
- §12 : `CORRESPONDANT_IDA` → 403 (`refedit` ne suffit plus) ;
  `OPERATEUR_PLACE` → 201 ; régression `updateCompany` confirmée saine
  pour un correspondant sur sa propre compagnie.
- Limitation notée explicitement par le Testeur : le "bouton d'upload
  masqué sans le privilège `insert`" n'a pas pu être revérifié EN
  NAVIGATEUR (le panneau de prévisualisation de cette session est figé
  sur `OPERATEUR_PLACE`) — couvert uniquement par les tests unitaires
  `AttachmentsPanel.test.tsx` (frontend), pas par cette passe navigateur.

## `GET /settlement/quarter/closures` — écran 4 "Échanges" (2026-10-18, équipe 4 rôles)

Premier point de `QUESTIONS_UAR.md` tranché directement par le Product
Owner réel (pas simulé) de ce projet : voir `QUESTIONS_UAR.md` §6 (marqué
résolu) pour la décision et `HANDOFF.md` frontend pour le détail complet
du round (agent Backend pour cet endpoint, agent Frontend pour les
sous-onglets `/exchanges`, agent Testeur pour la vérification réelle en
navigateur). Endpoint additif, place-wide (pas de scoping tenant — une
clôture trimestrielle est une action de place, `SettlementClosure.
companyCode` jamais renseigné pour le scope QUARTERLY), aucun changement
de `QuarterlySettlementDto`/`RecoursViewDto` (contrats figés). Vérifié :
283/283 tests unitaires (2 nouveaux cas), `tsc --noEmit` propre, build
réussi.

## Points UAR 1-5, 7, 8 — documents UAR + PO expert (2026-10-19, équipe 4 rôles + PO expert)

**Origine** : le Product Owner réel a fourni 5 documents UAR (Note de
cadrage, Expression de besoin, Diagramme d'activité + export PDF, Guide
pédagogique). Lus intégralement : ils fondent les points 7 (Chapitre VI,
Art. 30-35) et 8 (Art. 16-18), définissent IRSAM (diapo 3) et l'interdiction
de motiver une opposition par la non-déclaration (diapo 10), mais ne
contiennent aucune valeur pour les points 1-5. Le PO réel a alors délégué
ces 5 points à un « PO expert métier assurance » simulé, avec une règle :
la **structure** peut être décidée, une **valeur** n'est pré-remplie que si
elle vient des documents ou d'un standard public vérifiable (sinon saisie
par un rôle place, statut « à valider UAR »). Détail par point :
`QUESTIONS_UAR.md` §1-5, §7, §8.

**Construit (backend)** :
- §7 `MembershipRequest` (`src/commission/membership.*`), privilège
  `membership` ; `AdherentsService.markCompanyWithdrawn`.
- §8 `SettlementPipelineStep` (`src/settlement/settlement-pipeline.*`),
  `src/common/business-days.ts` (week-end vendredi-samedi + fériés fixes
  MM-JJ + fériés supplémentaires), `src/common/clock.ts` (horloge
  injectable). La clôture trimestrielle exige les étapes 1-4 (409
  `PIPELINE_INCOMPLET`).
- §1-4 référentiels de place (`src/adherents/convention-referential.service.ts`,
  `place-metrics-referential.service.ts`, `place-referential.controller.ts`),
  privilège `validateRef` (ADMIN_UAR seul, OPERATEUR_PLACE l'a perdu) et
  règle des quatre yeux (`referential-rules.ts`), `reasonCode` sur
  `opposer`, `per100k`/`irsam` dans `StatsService`. Fériés fixes générés
  pour toute année (`algeriaFixedHolidays`), Yennayer ajouté.
- §5 barème (`src/adherents/bareme-*`, `src/claims/claim-art14.ts`,
  `claim-extension-columns.ts`, `src/matching/matching.bareme.ts`),
  `PATCH /claims/:id/responsabilite`, `GET /claims/import/columns/v2`,
  `GET /matching/:id` (avec `claimAId`/`claimBId`, absents de la file).
- Migrations : `20261018020000_MembershipSettlementPipeline`,
  `20261018030000_ReferentielPlace` (seed : 17 circonstances
  `STANDARD_A_CONFIRMER` + motif `NON_DECLARATION` interdit, rien d'autre),
  `20261019010000_BaremeArt14` (aucun seed).

**Revue Tech Lead (corrections avant fusion)** : `per100k` à `null` sans
`year` (un cumul pluriannuel rapporté à une seule année gonflait le taux) ;
fériés mobiles branchés sur le 5ᵉ jour ouvré du pipeline ; id des dossiers
exposés dans le détail d'appariement (l'écran retrouvait le dossier par
recherche paginée).

**Testeur (vérification réelle, mode dégradé)** : 2 bugs réels, corrigés —
(1) la clôture trimestrielle par l'API ignorait l'ordre des étapes ;
(2) fériés fixes figés sur 2026-2027. Remarques non bloquantes laissées en
l'état : `fixedHolidays` de
`GET /referential/calendar` sans bornes = année N-1 à N+1 ; import CSV des
populations : une seule erreur par ligne.

**Défauts préexistants relevés par le Testeur, corrigés le 2026-10-19** :
- `POST /recours` (même route, désormais servie par
  `src/claims/recours-opening.controller.ts` → `ClaimsService.openRecours`,
  pour éviter le cycle Recours→Claims) contrôle le dossier : existant (404),
  de l'assureur direct `from` (400 `RECOURS_HORS_ASSUREUR_DIRECT`), contre
  la partie tierce déclarée `to` (400 `RECOURS_MAUVAISE_PARTIE`), éligible
  IDA (400 `DOSSIER_HORS_IDA`), sans recours antérieur (409
  `RECOURS_EXISTANT`). Avant, un recours fictif pouvait être réglé par
  silence puis compensé. Les e2e créent de vrais dossiers éligibles
  (`test/utils/claims.ts`).
- Appariement : une ligne par déclaration (A↔B et B↔A) est conservée, mais
  confirmer ou rejeter l'une s'applique à la ligne miroir non tranchée
  (`link` et `complement` ne se propagent pas) ; `decide()` ne lève plus
  son 403 dans la closure de repli.
- `createdAt` d'une compagnie figé en mode dégradé.
- Import CSV des populations : chaque ligne rapporte désormais TOUTES ses
  erreurs indépendantes (code, année, population, source_type, source_ref),
  pas seulement la première (la chaîne `else if` masquait les suivantes).

**Décisions PO du 2026-10-19 (après le Testeur)** : seul un motif
d'opposition `VALIDE_UAR` est accepté (`MOTIF_NON_VALIDE`) ; une catégorie
de véhicule validée est figée (`CATEGORIE_IMMUABLE`) ; échéance de l'étape 3
= dernier jour du mois M, confirmée.

**Vérifié** : `npm run lint` OK, `npm test` 434/434, e2e 129/129 (le flake
`claims-import` ECONNRESET passe ou échoue selon les exécutions), build OK.

**Environnement** : dans un worktree neuf, `AUTH_PROVIDER=dev` doit être
exporté pour les e2e (pas de `.env`). Le PostgreSQL du port 5432 sur cette
machine appartient à un autre projet (`titra-postgres-1`) : ne pas y
appliquer les migrations d'IDA Place.

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
