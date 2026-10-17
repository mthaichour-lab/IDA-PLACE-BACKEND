# HANDOFF — pour le prochain agent Backend

Règle absolue : **ne change pas la forme des DTO/endpoints existants**
(`ClaimsModule`, `MatchingModule`, `CockpitModule`, `AdherentsModule`,
`ExpertsModule`, `AuthModule`, et depuis la vague 2 : `RecoursModule`,
`SettlementModule`, `CommissionModule`) — implémente la logique métier
**derrière** ces contrats, que le front consomme déjà. Si un besoin impose
vraiment un changement de forme, passe par une nouvelle version d'API
(`/api/v2`, C.4) plutôt qu'une rupture silencieuse sur `/api/v1`.

## Réel vs mocké — résumé rapide (mis à jour, sprint 2)

**Réel** (entités, migrations, DTO, services, tests) :
`AuthModule` (sauf Keycloak), `AdherentsModule`, `ExpertsModule`,
`LedgerModule` (logique de chaînage, pas la persistance), `AdminModule`
(uniquement `roles/matrix`), **`ClaimsModule`, `EligibilityModule`,
`MatchingModule`, `CockpitModule`** (implémentés durant ce sprint — voir
détail ci-dessous), **`RealtimeModule`** (authentification de connexion +
émission réelle de `claim.ingested`/`match.updated`, branchée sur
Claims/Matching).

**Mock minimal (squelette libre, peu de contraintes de forme), inchangé
dans ce sprint** : `RecoursModule`, `SettlementModule`, `CommissionModule`,
`MonitoringModule`, `FraudModule`, `MeteringModule` (sauf la grille
tarifaire, déjà réelle), `StatsModule`, `DocumentsModule` (S3),
`AdminModule.users`. **Non touchés** par ce sprint (hors périmètre, comme
demandé) même si leur build continue de passer.

Voir `ARCHITECTURE.md` § 4 pour le détail module par module (section à
rafraîchir par le prochain agent si de nouveaux modules deviennent réels).

## Ce qui a été implémenté dans ce sprint

### ClaimsModule

- Entité `Claim` (MikroORM, `src/claims/entities/claim.entity.ts`) sur le
  modèle B.3 : champs typés nécessaires à l'éligibilité et à l'appariement
  (plaques, police/attestation, GPS, dates, montants…) + `raw` (jsonb, la
  ligne source complète des 47 colonnes, pour audit/ré-évaluation future).
  Migration : `src/migrations/Migration20260201000000_ClaimsMatching.ts`.
- Parsing réel du fichier d'import (`src/claims/claim-parser.ts`) :
  **exceljs** pour `.xlsx`/`.xls` (ajouté à `package.json`, installable
  dans cet environnement — `npm view exceljs version` a répondu) ; un
  **parseur CSV maison** (`splitCsvLine`, gestion des guillemets/
  échappement, détection automatique `,` vs `;`) pour `.csv`/`.txt` plutôt
  qu'une dépendance supplémentaire — testé (`claim-parser.spec.ts`).
  Convention : 1ʳᵉ ligne = en-tête (ignorée), mapping par **position** de
  colonne selon `CLAIM_IMPORT_COLUMNS` (le modèle téléchargeable impose un
  ordre fixe). Erreurs de type/format par cellule renvoyées en motifs
  préfixés `"Erreur de format : …"` dans `ClaimImportRowResultDto.reasons`
  (pas de champ `errors` séparé ajouté : le contrat `ClaimImportRowResultDto`
  reste figé).
- Verdict ligne à ligne délégué à `EligibilityModule.evaluate(row)`.
- Persistance réelle + repli mémoire (mode dégradé, voir plus bas) ;
  pipeline de dossier : `ELIGIBLE_IDA` → état `A_APPARIER`, `HORS_IDA` →
  état `HORS_IDA` (hypothèse documentée dans `cockpit.module.ts` et
  `claims.service.ts` : pas de timer de recours réel tant que
  `RecoursModule` reste un mock).
- Après persistance de chaque ligne importée, déclenche le recalcul
  d'appariement (`MatchingService.ingestClaim`) et émet `claim.ingested`
  (`RealtimeGateway`) avec un résumé (`fileName`, `totalRows`,
  `eligibleCount`, `ineligibleCount`).
- `ClaimViewDto` : champs **optionnels ajoutés** (`commune`, `accidentTime`,
  `plateA/B`, `policeA/B`, `gpsLat/Lng`, `eligibilityVerdict`,
  `eligibilityReasons`) — aucun champ existant renommé/retiré.

### EligibilityModule

- Règles B.6 (Art. 3/4/5-6/13/19/28) en fonctions **pures**
  (`src/eligibility/eligibility.rules.ts`, testées dans
  `eligibility.rules.spec.ts`, 19 cas dont plusieurs cas limites : plafond
  exact, délai de recours exact à 6 mois, casse/espacement des pièces…).
  `EligibilityService` résout la configuration (plafond, délai, version de
  grille) depuis des variables d'environnement
  (`ELIGIBILITY_MAX_AMOUNT_DA`, `ELIGIBILITY_RECOURS_MAX_MONTHS`,
  `ELIGIBILITY_GRID_VERSION`), valeurs par défaut = celles du dossier
  (300 000 DA, 6 mois, "v2025.12").
- **Hypothèse à vérifier avec le métier** : la liste des pièces
  obligatoires (Art. 13) n'est pas fixée par le dossier technique (B.4 ne
  décrit qu'une colonne libre "Pièces fournies") — un vocabulaire a été
  assumé (`CONSTAT_AMIABLE`, `CARTE_GRISE`, `PERMIS_CONDUIRE`,
  `ATTESTATION_ASSURANCE`, voir `DEFAULT_ELIGIBILITY_CONFIG.requiredPieces`
  dans `eligibility.rules.ts`) et documenté en commentaire.
- **Hypothèse** : le délai de recours (Art. 19) est calculé depuis la
  **date de l'accident** (pas la date de déclaration) — à confirmer avec
  le métier, ajustable en un point (`evaluateEligibility`).

### MatchingModule

- Clé d'appariement + score pondéré en fonctions **pures**
  (`src/matching/matching.scoring.ts`, testées dans
  `matching.scoring.spec.ts`, 18 cas dont les seuils de tolérance exacts :
  60 min, 2 jours, 2 km GPS, cumul de poids 35+15+15+10+10=85).
- Entité `MatchQueueItem` (migration incluse dans
  `Migration20260201000000_ClaimsMatching.ts`) : **une ligne par
  déclaration** (`declAId`), appariée ou non avec sa meilleure contrepartie
  (`declBId`) — cohérent avec l'écran 2 ("Réf./Partie A/Partie B").
  `MatchingModule` n'importe jamais l'entité `Claim` (ARCHITECTURE.md :
  modules séparés par interfaces publiques) : `ClaimsService` lui passe des
  `ClaimMatchInput` (DTO interne, `matching.types.ts`).
- Seuils auto/à confirmer paramétrables via `MATCHING_AUTO_THRESHOLD` /
  `MATCHING_CONFIRM_THRESHOLD` (défaut 80/50, inchangé).
- `decide()` persiste réellement la décision (statut, `confirmedBy`,
  `confirmedAt`, `rejectReason`) et **préserve toute décision humaine déjà
  tranchée** (statuts terminaux `CONFIRME_MANUEL`/`REJETE`/`COMPLEMENT`) :
  un recalcul automatique ultérieur (nouvel import) ne l'écrase jamais —
  Art. 14, validation humaine obligatoire. Émet `match.updated`.
- ⚠️ **Bug corrigé pendant ce sprint, signalé par l'agent Frontend** :
  `MatchDecisionDto` (`action`/`reason`/`linkDeclId`) n'avait **aucun
  décorateur `class-validator`** → le `ValidationPipe` global
  (`whitelist: true`) les effaçait silencieusement avant qu'ils
  n'atteignent le contrôleur, donc `decide()` ne recevait jamais l'action
  réelle. Corrigé par l'ajout de `@IsIn`/`@IsOptional`/`@IsString`/
  `@IsNotEmpty` sur ces champs (`src/matching/dto/matching.dto.ts`), **sans
  changer les noms/la forme des champs**. Vérifié manuellement : `confirm`,
  `reject` (avec `reason`) et `complement` persistent bien `status` (et
  `rejectReason`) et sont visibles dans un `GET /matching/queue` suivant.
  **À garder en tête pour tout futur DTO d'entrée** : un champ sans
  décorateur `class-validator` est silencieusement supprimé par le
  `ValidationPipe` whitelist — vérifier systématiquement les DTO de
  requête (pas les DTO de réponse, qui n'ont pas besoin de validateurs).
- Repli mémoire : les objets internes (`declAId`/`declBId`) sont bien
  retirés avant toute sortie HTTP/WS (`toPublicDto`) — a été corrigé après
  détection manuelle d'une fuite de ces champs dans `GET /matching/queue`
  en mode dégradé (voir `matching.service.ts`).

### RealtimeModule

- Authentifie désormais la connexion WebSocket (même mécanisme que l'API
  REST — en-tête `x-dev-user` du handshake, via le même `AUTH_PROVIDER`) :
  une connexion non authentifiée est refusée (`disconnect`). Salon
  `tenant:place` (événements de place) + salon `tenant:<companyId>` pour un
  utilisateur rattaché à une compagnie (prêt pour de futurs événements
  scopés, ex. `recours.timer`).
- `claim.ingested` émis par `ClaimsService.importFile` ; `match.updated`
  émis par `MatchingService.decide()` et par
  `MatchingService.ingestClaim()` (recalcul après import).
- Toujours en mémoire (pas de pub/sub Redis) — un seul process backend
  supporté pour l'instant, TODO inchangé (voir §7).

### CockpitModule

- `GET /cockpit/summary` agrège désormais les vraies données de
  `ClaimsModule`/`MatchingModule` (forme de réponse inchangée). Hypothèses
  documentées en tête de `cockpit.module.ts` (dossiers du jour = créés
  aujourd'hui ; à apparier = file `A_CONFIRMER` ; en retard = dossiers
  `A_APPARIER` depuis plus de 7 jours, faute de timer `RecoursModule` réel ;
  compensation à venir = somme des montants des dossiers non réglés) — à
  affiner une fois `RecoursModule`/`SettlementModule` réels.

## Todo-list restante, par priorité

### 1. RecoursModule / SettlementModule / etc. (squelette libre, hors périmètre de ce sprint)

Logique métier de la section B.2 correspondante, en conservant Swagger à
jour. Pas touchés dans ce sprint (consigne explicite). Une fois
`RecoursModule` réel, revoir les hypothèses "en retard"/"compensation à
venir" du Cockpit (actuellement une approximation sans timer conventionnel
réel) et le délai de recours de l'Art. 19 (actuellement calculé depuis la
date de l'accident, pas la date de demande de recours réelle une fois
celle-ci tracée dans `RecoursModule`).

### 2. Persistance transverse à généraliser

- `RbacService` : toujours un singleton mémoire (inchangé ce sprint).
- `LedgerModule` : toujours en mémoire (inchangé ce sprint).
- **Scoping tenant toujours PAS appliqué** dans `ClaimsService`/
  `MatchingService` malgré leur passage en "réel" ce sprint : un
  `CORRESPONDANT_IDA`/`TRESORIER` voit actuellement TOUS les dossiers, pas
  seulement ceux de sa compagnie. `common/rbac/tenant-scope.ts`
  (`resolveTenantFilter`/`assertCompanyAccess`) existe déjà et est prêt à
  être branché sur `ClaimsService.list()`/`get()` (filtrer sur
  `company`/`counterpartyCompany`) — non fait ce sprint par prudence (le
  contrat `ListClaimsQueryDto` n'a pas de paramètre tenant explicite, et
  l'agent Frontend consomme déjà ces routes ; un filtrage serveur silencieux
  changerait le comportement observé sans changer la forme du DTO — à
  valider avec le Tech Lead avant de l'activer).

### 3. Intégrations externes (inchangé)

- `src/auth/strategies/keycloak.strategy.ts` : JWT/JWKS + mapping rôle.
- `src/documents/providers/s3.provider.ts` : upload/présignature réelle.
- Paperless : non amorcé.
- Redis : non branché (cache lecture, pub/sub RealtimeModule).

## Limites connues à signaler au Testeur

- **Pas de PostgreSQL disponible dans cet environnement** (`docker compose
  up -d postgres` échoue : pas de démon Docker). Toute la vérification de
  ce sprint a été faite en **mode dégradé** (repli mémoire) : les entités
  et la migration (`Migration20260201000000_ClaimsMatching.ts`) sont
  écrites et type-checkées mais **n'ont jamais été exécutées contre une
  vraie base** — à valider dès qu'un PostgreSQL est disponible
  (`npm run migration:up` puis réessayer les mêmes scénarios).
- En mode dégradé, le repli mémoire est **un singleton par process** : les
  dossiers/décisions importés disparaissent au redémarrage du serveur
  (attendu, voir README "Mode dégradé" — pas un bug).
- Le mapping des 47 colonnes à l'import se fait **par position**, pas par
  libellé d'en-tête : un fichier dont les colonnes seraient dans un ordre
  différent du modèle téléchargeable sera mal interprété sans erreur
  explicite autre que des échecs de validation en cascade. À améliorer
  (vérification de l'en-tête) si des imports réels divergent du modèle.
- La liste des pièces obligatoires (Art. 13) et le point de départ du délai
  de recours (Art. 19, date accident vs date déclaration) sont des
  **hypothèses documentées**, pas des règles explicitement données par le
  dossier technique — à faire valider par le métier.
- `exceljs` a été ajouté aux dépendances (`npm install exceljs@4.4.0`) et
  fonctionne dans cet environnement ; non testé en conditions réelles avec
  un classeur `.xlsx` complexe (feuilles multiples, styles) — seul le cas
  "une feuille, valeurs simples" est couvert par construction.

## Vérifications effectuées dans ce sprint

- `npx tsc --noEmit` : OK, aucune erreur.
- `npx nest build` : OK (sortie dans `dist/src/`).
- `npx jest` : **56/56 tests passent** (5 suites : `AdherentsService`,
  `eligibility.rules` — 19 cas B.6 avec cas limites, `matching.scoring` —
  18 cas B.5 avec cas limites, `claim-parser` — 12 cas (CSV, erreurs de
  type), `claims.service` — 4 scénarios d'intégration import→éligibilité→
  appariement en mode dégradé).
- Démarrage réel (`node dist/src/main.js`) **sans PostgreSQL/Redis/MinIO/
  Keycloak lancés** : démarre proprement, logge le mode dégradé pour
  chaque appel Claims/Matching, et le scénario suivant a été exécuté
  manuellement de bout en bout avec `curl` :
  1. `POST /claims/import` avec un CSV de 2 déclarations du même accident
     (même n° e-constat, compagnies croisées CAAT/SAA) → rapport
     `ELIGIBLE_IDA` sur les 2 lignes ;
  2. `GET /matching/queue` → 2 lignes, score 100, `econstatShared: true`,
     `level: AUTO`, `status: AUTO_CONFIRME` ;
  3. `POST /matching/:id/decide` (`reject` avec motif, `confirm`, puis
     `complement` sur un 2ᵉ import) → `GET /matching/queue` confirme que
     `status`/`confirmedBy`/`confirmedAt`/`rejectReason` sont bien
     **persistés** (bug du DTO non validé corrigé, voir plus haut) ;
  4. `AUDITEUR_CSA` → 403 sur `decide` (RBAC toujours respecté) ; id
     inconnu → 404 normalisé ;
  5. `GET /cockpit/summary` → KPIs calculés à partir des dossiers importés
     (plus de valeurs figées) ;
  6. `GET /claims` → dossiers importés visibles, champs optionnels
     (plaques, police, GPS…) renseignés.
- `GET /referential/wilayas` renvoie bien 69 entrées (codes 01→69) en
  mode dégradé (inchangé, non touché ce sprint).

---

## Vague 2 — RecoursModule, SettlementModule, CommissionModule (réel)

Règle respectée : les routes `GET /recours?filter&page` et
`POST /recours/{id}/transition`, ainsi que `GET /settlement/monthly/{period}`
et `GET /settlement/quarter/{q}` (B.11), sont CONSERVÉES. Leur corps de
réponse, auparavant un squelette libre ("mock minimal, peu de contraintes
de forme" — ARCHITECTURE.md §4 avant cette vague), est désormais la vraie
forme réelle et doit être traité comme stable à partir de maintenant (voir
ARCHITECTURE.md §1, mis à jour). `CommissionModule` n'avait aucune route
imposée par B.11 : ses routes ont été conçues proprement, en cohérence avec
le reste de l'API (préfixe `/api/v1`, pagination `{page,total,items}` 6/p,
erreurs normalisées `{code,message,details}`).

### RecoursModule (écran 4 — Échanges Annexes 2/3/4)

- Entité `Recours` (MikroORM, `src/recours/entities/recours.entity.ts`)
  conforme à B.3 : `id, claimId, from, to, state, requestSentAt, responseAt,
  opposition{...}, contestation{...}, commissionAt, settledAt, amount` (+
  `resolution` additionnel, documentant COMMENT le recours s'est conclu —
  utile pour la fiche détail de l'écran 4). Migration :
  `src/migrations/Migration20260301000000_RecoursSettlementCommission.ts`.
- Machine d'état + timers conventionnels en fonctions **pures** testées
  (`src/recours/recours.rules.ts`, 7 états : `EN_ATTENTE, OPPOSITION,
  CONTESTATION, COMMISSION, REGLE, REJETE, FORCLOS` — cohérents avec le
  vocabulaire déjà présent dans `CLAIM_STATES`, `src/claims/dto/claim.dto.ts`,
  qui citait déjà `EN_RECOURS/REGLE/FORCLOS`) :
  - **Art. 10** (silence = acceptation tacite) : si aucune réponse de la
    compagnie adverse dans `silenceDays` jours après l'envoi
    (`requestSentAt`), le recours bascule automatiquement en `REGLE`.
  - **Art. 12** (opposition non traitée = réputée fondée) : si une
    opposition en cours n'est pas tranchée dans `oppositionDays` jours, le
    recours bascule en `REJETE` (`opposition.status = FONDEE_TACITE`).
  - **Art. 19** (forclusion globale) : au-delà de `forclusionMonths` mois
    depuis `requestSentAt`, le recours bascule en `FORCLOS`, PRIORITAIRE sur
    tout autre sous-état (vérifié en premier dans
    `applyAutomaticTransitions`).
  - Ces transitions AUTOMATIQUES sont appliquées **paresseusement** (lazy) :
    `RecoursService` les évalue à chaque lecture (`list`/`get`/`counters`)
    et écriture (`transition`), faute d'ordonnanceur (cron) dans ce sprint
    — voir limite connue ci-dessous.
  - Transitions MANUELLES (validation humaine) via
    `POST /recours/{id}/transition` : `accepter, opposer, lever_opposition,
    contester, transmettre_commission, cloturer_commission_favorable,
    cloturer_commission_defavorable` — choix délibéré d'un champ `action`
    validé (`@IsIn`) plutôt qu'un `toState` libre (le mock initial), pour
    éviter la classe de bug déjà rencontrée au sprint 2 sur `MatchDecisionDto`
    (champ sans validateur silencieusement effacé par le `ValidationPipe`
    whitelist) et pour garantir que seules les transitions métier valides
    sont possibles (machine d'état stricte, `isActionAllowed`).
  - `countdownBar` : `computeTimerState` calcule côté serveur le timer actif
    (type, échéance, jours restants, expiré) exposé dans `timer` sur chaque
    `RecoursViewDto` — le front n'a **aucun** calcul de délai à faire (C.1).
  - ⚠️ **HYPOTHÈSE À VALIDER PAR LE MÉTIER** : le dossier technique cite les
    Art. 10/12/19 mais ne fixe pas la durée exacte des délais Art.10
    (silence) et Art.12 (opposition) — seul le délai de forclusion de 6
    mois (Art.19) est donné (B.6, réutilisé ici via la MÊME variable
    d'environnement que `EligibilityModule`, `ELIGIBILITY_RECOURS_MAX_MONTHS`,
    cohérence demandée par la mission). Valeurs par défaut choisies,
    paramétrables par environnement :
    `RECOURS_SILENCE_DAYS` (défaut **30 jours**),
    `RECOURS_OPPOSITION_DAYS` (défaut **15 jours**). À confirmer avec le
    métier avant mise en production.
  - Endpoints additionnels (non rompant le contrat B.11, simple ajout) :
    `GET /recours/counters` (compteurs par onglet, même esprit que
    `GET /matching/queue/counters`), `GET /recours/{id}` (fiche détail,
    requise par A.4 "fiche détail par recours" mais absente de la liste
    d'exemples B.11), `POST /recours` (enregistrement d'un nouveau recours
    — nécessaire puisque rien d'autre ne peuplait le registre : privilège
    `insert`).
  - Événement temps réel `recours.timer` (déjà prévu dans le type
    `RealtimeEvent` de `RealtimeModule`, non modifié) émis à chaque
    transition (automatique ou manuelle).
  - Repli mémoire (mode dégradé) : **attention à ne jamais confondre une
    exception MÉTIER (404 "introuvable", 400 "transition invalide") avec
    une bascule en mode dégradé** — `withDegradedFallback` catche N'IMPORTE
    QUELLE exception levée dans son callback DB, y compris les nôtres.
    `RecoursService.transition()` (et son équivalent dans
    `CommissionService`) contourne volontairement ce piège via
    `loadForTransition`/`loadCaseForMutation` : la lecture (DB ou mémoire)
    est séparée de la levée des exceptions métier, pour ne jamais masquer
    un 400 derrière un faux "404 mode dégradé" (voir commentaire dans le
    code). **À vérifier/généraliser** : ce même piège existe potentiellement
    déjà dans `MatchingService.decide()` (sprint 2, non touché ici — sa
    `NotFoundException` lève le même type d'exception dans les deux
    branches, donc le symptôme ne s'y voit pas, mais le mécanisme est le
    même) ; à garder en tête pour tout futur service qui lèverait des
    exceptions de types différents entre le chemin DB et le chemin mémoire.

### SettlementModule (écrans 5 et 6)

- Dépend de `RecoursModule` (lecture seule, interface publique
  `RecoursService.listAll()` — jamais l'entité `Recours`, voir
  ARCHITECTURE.md). Fonctions pures de parsing/netting dans
  `src/settlement/settlement.rules.ts`, testées (`settlement.rules.spec.ts`).
- **Cycle mensuel** (`GET /settlement/monthly/{period}`, ex: `period=2026-01`) :
  regroupe les recours par compagnie **demanderesse** (`from`) sur leur
  **mois d'envoi** (`requestSentAt`) — hypothèse documentée, le dossier
  technique ne précisant pas cette convention. Expose `claimsCount`,
  `resolvedCount` (état d'avancement réel : combien sont déjà
  `REGLE/REJETE/FORCLOS`), `totalAmount`, `status` (`EN_COURS`/`CLOTURE`).
  `POST /settlement/monthly/{period}/close` (privilège `synth`) persiste une
  clôture (`SettlementClosure`, entité additionnelle — voir ci-dessous) et
  génère un `bordereauRef` ; idempotent par compagnie+période (409 sinon).
- **Compensation trimestrielle** (`GET /settlement/quarter/{q}`, ex:
  `q=2026-Q1`) : calculée **uniquement à partir des recours RÉGLÉS**
  (`state === 'REGLE'`, conformément à la mission), sur leur date de
  règlement (`settledAt`) si connue, sinon leur date d'envoi en repli
  (hypothèse documentée — `settledAt` n'est jamais encore posé
  automatiquement dans ce sprint, voir limite ci-dessous). Deux résultats :
  - `positions` : netting **bilatéral** (`computeBilateralNetPositions`) —
    réduit chaque paire {A,B} à une seule direction nette ; une paire
    parfaitement compensée disparaît.
  - `net` : compensation **multilatérale** (`computeMultilateralNetPositions`)
    — position nette unique par compagnie vis-à-vis de la "place"
    (chambre de compensation). Invariant garanti et testé : la somme de
    toutes les positions nettes est toujours 0. Contrairement au netting
    bilatéral, elle annule aussi les cycles à 3 compagnies ou plus (test
    dédié dans `settlement.rules.spec.ts` : un cycle A→B→C→A de montants
    égaux donne 300 de brut bilatéral mais 0 de net multilatéral partout —
    c'est précisément l'intérêt de la compensation multilatérale par
    rapport au règlement bilatéral pair à pair).
  - `POST /settlement/quarter/{q}/close` (privilège `synth`) : idempotent
    (409 si déjà clôturé), génère le bordereau trimestriel.
- Entité additionnelle `SettlementClosure` (non nommée dans B.3, qui ne
  détaille que `Recours`/`Invoice`) : trace une clôture (scope MONTHLY ou
  QUARTERLY, période, compagnie si mensuelle, bordereau, auteur, date) —
  nécessaire pour qu'une clôture survive un redémarrage et ne soit jamais
  rejouée deux fois. Migration incluse dans
  `Migration20260301000000_RecoursSettlementCommission.ts`.
- **Non fait, hors périmètre de cette vague** : génération réelle d'un
  bordereau PDF/Excel téléchargeable (B.10/DocumentsModule) — seul un
  `bordereauRef` (identifiant) est généré ; `Invoice` (B.3) n'est pas
  branché ici (c'est plutôt `MeteringModule`, déjà réel pour la grille
  tarifaire, qui s'en charge pour la facturation d'infrastructure — à ne
  pas confondre avec les bordereaux de compensation IDA).

### CommissionModule (écran 7)

- Entités additionnelles (non nommées dans B.3, documentées ici) :
  `CommissionCase` (`id, recoursId, claimId, companyA, companyB, amount,
  motif, status, scheduledAt, decidedAt?, decision?, pv?`) et `Sanction`
  (`id, commissionCaseId?, companyCode, type, amount?, reason, orderedAt,
  orderedBy`). Migration incluse dans
  `Migration20260301000000_RecoursSettlementCommission.ts`.
- Machine d'état séquentielle et testée (`commission.rules.ts`) :
  `A_INSTRUIRE -> EN_DELIBERE -> PRONONCE`, jamais de retour en arrière ni
  de saut d'étape (`canAdvanceCaseStatus`) — `POST /commission/cases/{id}/decide`
  est donc refusé (400) si le dossier n'est pas passé par
  `POST /commission/cases/{id}/deliberate` au préalable.
- `POST /commission/cases` dénormalise `claimId`/`companyA`/`companyB`/
  `amount` depuis le recours (`RecoursService.get()`, lecture seule, 404
  normalisé si le recours n'existe pas) — **limite connue, choix
  architectural délibéré** : `RecoursModule -> CommissionModule` n'existe
  PAS (pas d'appel automatique quand un recours passe en `COMMISSION` via
  `transmettre_commission`) pour éviter tout cycle de modules
  (`CommissionModule` dépend déjà de `RecoursModule` en lecture). Le
  correspondant doit donc, en deux temps : (1) transitionner le recours
  (`transmettre_commission`) puis (2) ouvrir le dossier de commission
  (`POST /commission/cases`). Piste d'amélioration pour une vague
  ultérieure : automatiser ce couplage via un événement
  (`RealtimeGateway.emitEvent`, déjà utilisé pour la diffusion WebSocket,
  pourrait aussi servir de bus interne léger) plutôt qu'un appel de service
  direct qui créerait un cycle.
- `POST /commission/cases/{id}/penalty` et `.../sanction` valident que la
  compagnie visée (`companyCode`) est bien partie au recours
  (`isCompanyPartyToCase`, 400 sinon) — sanction/pénalité toujours
  rattachée au bon dossier, jamais à une compagnie tierce par erreur.
- `POST /commission/cases/{id}/pv-sign` n'est permis qu'après le prononcé
  (`status === 'PRONONCE'`, 400 sinon) — le PV scelle une décision déjà
  rendue, jamais une délibération en cours.
- Endpoints : `GET/POST /commission/cases[...]`, `GET /commission/sanctions`
  (registre paginé, filtrable par compagnie — utile pour une future
  intégration avec `MonitoringModule`, non faite ici, hors périmètre).
- **Non fait, hors périmètre de cette vague** : génération réelle du PV en
  document téléchargeable (B.10/DocumentsModule) — seule une référence
  (`pv.ref`) est générée ; lien `MonitoringModule` (le scoring de conformité
  B.2 écran 8 pondère notamment les sanctions à 5 % — `MonitoringModule`
  reste un mock avec des valeurs en dur, non branché sur
  `GET /commission/sanctions` dans cette vague).

### Limites connues à transmettre à la vague suivante (Monitoring/Fraud/Metering/Stats) et au Testeur

1. **Scoping tenant toujours pas appliqué** (voir ARCHITECTURE.md §3) :
   `RecoursService`/`SettlementService`/`CommissionService` exposent
   l'intégralité des données à tout rôle authentifié, y compris
   `CORRESPONDANT_IDA`/`TRESORIER` qui ne devraient voir que leur propre
   compagnie (B.7, minimisation loi 18-07). `resolveTenantFilter`/
   `assertCompanyAccess` (`common/rbac/tenant-scope.ts`) existent et sont
   prêts à être branchés — non fait par prudence (mêmes raisons que pour
   ClaimsModule au sprint 2 : pas de paramètre tenant dans les DTO de
   requête actuels, agents Frontend/Testeur consomment déjà ces routes).
2. **Timers Art.10/12 évalués paresseusement (lazy), pas d'ordonnanceur
   dédié** : un recours dont le timer a expiré ne bascule d'état QUE lors
   de la prochaine lecture/écriture le concernant (`GET /recours`,
   `GET /recours/{id}`, `POST /recours/{id}/transition`, ou indirectement
   via `SettlementService`/`CommissionService` qui appellent
   `RecoursService.listAll()`). En l'absence de tout accès pendant
   plusieurs mois, un recours resterait affiché `EN_ATTENTE` alors que son
   délai est dépassé, jusqu'au prochain accès. Piste pour la vague
   suivante : un job planifié (ex: cron NestJS `@nestjs/schedule`, non
   installé) qui appelle périodiquement `RecoursService.listAll()` (ou une
   méthode dédiée) pour forcer l'évaluation et émettre `recours.timer` même
   sans consultation — pas fait ici pour rester dans le périmètre (aucune
   dépendance de planification n'était déjà présente dans le projet).
3. **`settledAt` jamais posé automatiquement** : la compensation
   trimestrielle retombe sur `requestSentAt` en l'absence de `settledAt`
   (hypothèse documentée ci-dessus). Aucune méthode ne pose `settledAt`
   pour l'instant (ni `RecoursService`, ni `SettlementService`) — à
   décider : est-ce `SettlementService.closeQuarterly()` qui devrait
   marquer `settledAt = now()` sur chaque recours inclus dans le
   bordereau clôturé (verrouillant alors la position déjà clôturée pour
   les trimestres suivants) ? Choix métier à trancher avant la vague
   suivante.
4. **`RecoursModule -> CommissionModule` reste manuel en deux temps** (voir
   plus haut) — aucune automatisation de la création du dossier de
   conciliation à la transmission d'un recours.
5. **Pas de PostgreSQL disponible dans cet environnement** (inchangé depuis
   le sprint 2) : toute la vérification de cette vague (tests Jest +
   scénario manuel `curl` de bout en bout, voir ci-dessous) a été faite en
   **mode dégradé** (repli mémoire). Les 3 nouvelles entités et la migration
   (`Migration20260301000000_RecoursSettlementCommission.ts`) sont écrites
   et type-checkées mais **n'ont jamais été exécutées contre une vraie
   base** — à valider dès qu'un PostgreSQL est disponible
   (`npm run migration:up` puis réessayer les mêmes scénarios).
6. **`MonitoringModule` reste un mock** avec des pondérations en dur (B.2
   écran 8 : délais 30 %, silences 15 %, oppositions 15 %, qualité données
   15 %, forclusions 10 %, demandes tardives 10 %, pénalités 5 %) — toutes
   les données sources existent désormais réellement
   (`RecoursService.listAll()` pour délais/silences/oppositions/
   forclusions, `CommissionService.listSanctions()` pour les pénalités) :
   c'est la vague suivante qui doit les brancher, cette vague n'y a pas
   touché (hors périmètre explicite de la mission).

### Vérifications effectuées dans cette vague

- `npx tsc --noEmit` : OK, aucune erreur.
- `npx nest build` : OK.
- `npx jest` : **132/132 tests passent** (11 suites, dont les 56 tests du
  sprint 2 inchangés + 76 nouveaux : `recours.rules.spec.ts` (24 cas, timers
  Art.10/12/19 avec cas limites exacts aux échéances), `recours.service.spec.ts`
  (11 scénarios d'intégration en mode dégradé), `settlement.rules.spec.ts`
  (19 cas, dont le cycle à 3 compagnies et l'invariant somme nette = 0),
  `settlement.service.spec.ts` (6 scénarios), `commission.rules.spec.ts`
  (7 cas), `commission.service.spec.ts` (9 scénarios).
- Démarrage réel (`node dist/src/main.js`) **sans PostgreSQL/Redis/MinIO/
  Keycloak lancés** : démarre proprement (tous les modules s'initialisent,
  toutes les routes se mappent, y compris les nouvelles). Scénario manuel
  `curl` de bout en bout exécuté :
  1. `POST /recours` (CAAT→SAA, 85 000 DA) → `EN_ATTENTE`, `timer.timerType
     = SILENCE_ART10`, `remainingDays = 30` ;
  2. `POST /recours/{id}/transition` `opposer` → `OPPOSITION`,
     `timer.timerType = OPPOSITION_ART12` ; `contester` → `CONTESTATION`,
     timer retombe sur `FORCLUSION_ART19` ; `transmettre_commission` →
     `COMMISSION` ;
  3. `POST /recours/{id}/transition` `accepter` depuis `COMMISSION` → `400
     INVALID_TRANSITION` (machine d'état respectée) ;
  4. `POST /commission/cases` avec ce `recoursId` → dossier créé,
     `companyA/companyB/amount` bien dénormalisés depuis le recours ;
     `deliberate` → `EN_DELIBERE` ; `decide` (`RECOURS_FONDE`) →
     `PRONONCE` ; `pv-sign` → `pv.ref` posé ; `penalty` sur `SAA` (partie)
     → OK ; `penalty` sur `CASH` (tiers) → `400 BAD_REQUEST` ;
  5. `x-dev-user: AUDITEUR_CSA` sur `POST /recours/{id}/transition` → `403
     FORBIDDEN` (RBAC lecture seule toujours respecté) ;
  6. Deux recours supplémentaires créés et acceptés (CAAT→SAA 100 000,
     SAA→CAAT 30 000) → `GET /settlement/monthly/{period}` affiche bien
     `claimsCount`/`resolvedCount`/`totalAmount` par compagnie ;
     `GET /settlement/quarter/{q}` affiche `positions: [{CAAT→SAA,
     70000}]` (netting bilatéral 100000-30000) et `net` avec somme nette
     ≈ 0 ; `POST .../close` idempotent (409 à la 2ᵉ tentative).
