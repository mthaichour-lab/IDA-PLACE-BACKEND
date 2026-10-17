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
  `MatchingModule` et `CockpitModule` (écrans 1, 2, 3 — priorité du sprint 2)
  sont figés dans leur FORME. Depuis la vague 2, s'ajoutent à cette liste
  `RecoursModule` (écran 4), `SettlementModule` (écrans 5/6) et
  `CommissionModule` (écran 7) : leurs routes `GET/POST /recours*`,
  `GET/POST /settlement/*` et `GET/POST /commission/*` sont désormais la
  vraie forme réelle (plus un squelette libre) et ne doivent plus changer de
  FORME sans nouvelle version d'API (`/api/v2`). Le prochain agent Backend
  (Monitoring/Fraud/Metering/Stats) remplace les mocks restants par la
  vraie logique sans changer les DTO/routes déjà réels.
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
  `TRESORIER` ne voit que sa compagnie) — **toujours pas appliqué dans les
  services existants**, y compris `ClaimsService`/`MatchingService` (réels
  depuis le sprint 2) et `RecoursService`/`SettlementService`/
  `CommissionService` (réels depuis la vague 2) : tous exposent
  aujourd'hui l'intégralité des dossiers/recours/compensations à tout rôle
  authentifié, quelle que soit sa compagnie de rattachement. Voir
  HANDOFF.md §"Limites connues" — le câblage reste volontairement différé
  (mêmes raisons : aucun paramètre tenant explicite dans les DTO de requête
  actuels, et les agents Frontend/Testeur consomment déjà ces routes sans
  filtre serveur ; à valider avec le Tech Lead avant activation).

## 4. État d'avancement module par module

| Module | État | Détail |
|---|---|---|
| `AuthModule` | **RÉEL** | `GET /me`, `DevAuthProvider` fonctionnel, `KeycloakStrategy` = interface + TODO explicite (lève une erreur si activé sans implémentation). |
| `AdherentsModule` | **RÉEL** | Entités MikroORM (`Company`, `Agency`, `Wilaya`), migration, DTO, CRUD, pagination 6/p, repli mémoire si DB absente. |
| `ExpertsModule` | **RÉEL** | Entité `Expert`, DTO, CRUD, pagination. |
| `ClaimsModule` | **RÉEL** (sprint 2) | Entité `Claim` + migration, parsing réel Excel (`exceljs`)/CSV (parseur maison), verdict délégué à `EligibilityModule`, persistance (+ repli mémoire), déclenche l'appariement et émet `claim.ingested`. Voir HANDOFF.md. |
| `EligibilityModule` | **RÉEL** (sprint 2) | Règles B.6 (Art. 3/4/5-6/13/19/28) en fonctions pures testées (`eligibility.rules.spec.ts`), config paramétrable par env. |
| `MatchingModule` | **RÉEL** (sprint 2) | Clé exacte/composite + score pondéré en fonctions pures testées (`matching.scoring.spec.ts`), entité `MatchQueueItem` + migration, décisions persistées (+ repli mémoire), émet `match.updated`. Voir HANDOFF.md. |
| `RecoursModule` | **RÉEL** (vague 2 + correctifs RBAC) | Entité `Recours` + migration, machine d'état + timers conventionnels Art.10/12/19 en fonctions pures testées (`recours.rules.spec.ts`), persistance (+ repli mémoire), `countdownBar` calculée serveur. Autorisation par action (bon côté `from`/`to`, clôture commission réservée aux rôles "place") et scoping tenant sur `list`/`get`/`counters` ajoutés en revue Product Owner, sprint 3 (absents de la vague 2). Voir HANDOFF.md. |
| `SettlementModule` | **RÉEL** (vague 2 + correctifs RBAC) | Synthèse mensuelle par compagnie et compensation multilatérale trimestrielle calculées à partir des vrais `Recours` (RecoursModule), clôtures persistées (`SettlementClosure` + migration), netting bilatéral/multilatéral en fonctions pures testées (`settlement.rules.spec.ts`). Scoping tenant sur `monthly`/`quarter` ajouté en revue Product Owner, sprint 3 (absent de la vague 2). Voir HANDOFF.md. |
| `CommissionModule` | **RÉEL** (vague 2) | File de conciliation (`CommissionCase`) + pénalités/sanctions (`Sanction`) + PV, entités + migration, machine d'état séquentielle testée (`commission.rules.spec.ts`), dénormalisation depuis `RecoursModule` (lecture seule) à l'ouverture d'un dossier. Voir HANDOFF.md. |
| `MonitoringModule` | **MOCK minimal** | Scoring composite avec les VRAIES pondérations B.2 écran 8, valeurs calculées en dur. |
| `FraudModule` | **MOCK minimal** | Cas + journal d'actions, pas de détection réelle. |
| `MeteringModule` | **MOCK (grille réelle)** | Grille tarifaire TARIF-2026.01 = valeurs réelles du dossier (B.8), calcul de facture réel à partir de mesures mockées. Pas de collecte OpenTelemetry. |
| `StatsModule` | **MOCK** | Réutilise le vrai référentiel des 69 wilayas, mesures aléatoires déterministes. |
| `LedgerModule` | **RÉEL (persisté)** | Chaînage SHA-256 `hash(n)=f(event,hash(n-1))` réellement implémenté et vérifiable (`GET /ledger/verify`), désormais append-only en base (`ledger_entry`, `Migration20260301000001_Ledger.ts`), repli mémoire équivalent si PostgreSQL absent. |
| `AdminModule` | **PARTIEL** | `GET/PUT /admin/roles/matrix` **RÉEL** (branché sur `RbacService`, effet immédiat sur les autorisations). `GET/POST /admin/users` = mock. |
| `DocumentsModule` | **PARTIEL** | Interface `StorageProvider` réelle + `LocalFsStorageProvider` fonctionnel (mode dégradé assumé) ; `S3StorageProvider` = TODO explicite ; pas d'intégration Paperless. |
| `RealtimeModule` | **RÉEL (partiel)** (sprint 2) | Gateway Socket.IO (`/realtime`) authentifiée (même `AUTH_PROVIDER` que l'API REST), salons `tenant:place`/`tenant:<companyId>`. Émet réellement `claim.ingested` (ClaimsModule) et `match.updated` (MatchingModule). Toujours en mémoire (pas de pub/sub Redis) — un seul process backend. |
| `CockpitModule` *(additionnel)* | **RÉEL** (sprint 2) | `GET /cockpit/summary` — agrège les vraies données de ClaimsModule/MatchingModule (forme inchangée). Hypothèses documentées dans le fichier (voir HANDOFF.md). |

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
