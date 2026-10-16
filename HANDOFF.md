# HANDOFF — pour le prochain agent Backend

Règle absolue : **ne change pas la forme des DTO/endpoints existants**
(`ClaimsModule`, `MatchingModule`, `CockpitModule`, `AdherentsModule`,
`ExpertsModule`, `AuthModule`) — implémente la logique métier **derrière**
ces contrats, que le front consomme déjà. Si un besoin impose vraiment un
changement de forme, passe par une nouvelle version d'API (`/api/v2`,
C.4) plutôt qu'une rupture silencieuse sur `/api/v1`.

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
