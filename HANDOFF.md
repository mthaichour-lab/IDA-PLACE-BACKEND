# HANDOFF — pour le prochain agent Backend

Règle absolue : **ne change pas la forme des DTO/endpoints existants**
(`ClaimsModule`, `MatchingModule`, `CockpitModule`, `AdherentsModule`,
`ExpertsModule`, `AuthModule`) — implémente la logique métier **derrière**
ces contrats, que le front consomme déjà. Si un besoin impose vraiment un
changement de forme, passe par une nouvelle version d'API (`/api/v2`,
C.4) plutôt qu'une rupture silencieuse sur `/api/v1`.

## Réel vs mocké — résumé rapide

**Réel** (entités, migrations, DTO, services, tests) :
`AuthModule` (sauf Keycloak), `AdherentsModule`, `ExpertsModule`,
`LedgerModule` (logique de chaînage, pas la persistance), `AdminModule`
(uniquement `roles/matrix`).

**Mock à forme stable, à implémenter en vraie logique sans renommer/
déplacer de champs** : `ClaimsModule`, `MatchingModule`, `CockpitModule`.

**Mock minimal (squelette libre, peu de contraintes de forme)** :
`EligibilityModule`, `RecoursModule`, `SettlementModule`,
`CommissionModule`, `MonitoringModule`, `FraudModule`, `MeteringModule`
(sauf la grille tarifaire, déjà réelle), `StatsModule`, `DocumentsModule`
(S3), `RealtimeModule`, `AdminModule.users`.

Voir `ARCHITECTURE.md` § 4 pour le détail module par module.

## Todo-list précise, par priorité

### 1. ClaimsModule (priorité haute)

- Remplacer `buildMockImportReport` (`src/claims/claims.service.ts`) par
  un vrai parsing Excel/CSV des 47 colonnes (`src/claims/claim-47-
  columns.ts` — contrat de colonnes **figé**, ne pas renommer les `key`).
  Librairie suggérée : `exceljs` (xlsx) + un parseur CSV simple.
- Créer l'entité `Claim`/`Declaration` (MikroORM) sur le modèle B.3, avec
  migration. Remplacer `MOCK_CLAIMS`.
- Déléguer le verdict ligne à ligne à `EligibilityModule` (voir ci-dessous)
  au lieu du tirage pseudo-aléatoire de `buildMockImportReport`.
- Émettre `claim.ingested` via `RealtimeGateway.emitEvent(...)` après un
  import réussi.
- Ne pas changer la forme de `ClaimImportReportDto`, `ClaimViewDto`, ni
  les routes `POST /claims/import`, `GET /claims`, `GET /claims/:id`.

### 2. EligibilityModule (priorité haute, dépendance de Claims)

- Implémenter les règles B.6 (Art. 3/4/5-6/13/19/28) comme fonctions
  pures testables (`evaluate(row): {verdict, reasons[]}`), avec le
  plafond (300 000 DA, "v2025.12") et les délais paramétrables (pas en
  dur).
- Exposer un service injectable que `ClaimsModule` consomme.

### 3. MatchingModule (priorité haute)

- Remplacer `buildMock()`/`MOCK_QUEUE` (`src/matching/matching.service.ts`)
  par le calcul réel de la clé d'appariement (exacte = e-constat partagé ;
  composite = plaques non ordonnées + date/heure ±2j/±60min + wilaya/
  commune + police/attestation croisés) et du score pondéré (B.5), sur les
  `Claim` réelles une fois `ClaimsModule` branché.
- Créer l'entité `MatchQueueItem` (B.3) + migration. Les seuils `auto`/
  `à confirmer` (actuellement 80/50 en dur dans `getThresholds()`) doivent
  devenir paramétrables (écran 14 ou config dédiée).
- `decide()` doit persister la décision et respecter "validation humaine
  obligatoire" pour le barème Art. 14.
- Émettre `match.updated` via `RealtimeGateway`.
- Ne pas changer la forme de `MatchQueueItemDto`, `MatchDecisionDto`, ni
  les routes `GET /matching/queue`, `POST /matching/:id/decide`.

### 4. RealtimeModule (priorité moyenne)

- Authentifier la connexion WebSocket (actuellement aucune vérification
  à la connexion — voir TODO dans `realtime.module.ts`).
- Remplacer l'intervalle de démonstration par de vrais appels
  `emitEvent('claim.ingested' | 'match.updated' | 'recours.timer' |
  'metering.tick' | 'ledger.appended', payload)` depuis les modules
  concernés (B.12).
- Pour supporter plusieurs instances du back-end, passer par un pub/sub
  Redis plutôt que l'émission directe en mémoire.

### 5. Autres modules (priorité basse, squelette libre)

Pour chacun des modules "mock minimal" listés ci-dessus : implémenter la
logique métier décrite dans la section B.2 correspondante du dossier
technique, en conservant Swagger à jour. Pas de contrainte de forme forte
(pas encore consommés en détail par un écran front prioritaire), mais
éviter les ruptures une fois qu'un écran du front s'y branche.

### 6. Persistance transverse à généraliser

- `RbacService` (matrice rôles × privilèges) : actuellement un singleton
  mémoire, perdu au redémarrage. Persister `RolePermMatrix` (B.3).
- `LedgerModule` : la logique de chaînage est réelle et testée
  (`verifyChain()`), mais le stockage est en mémoire. Passer à une table
  append-only (pas d'UPDATE/DELETE applicatif).
- Appliquer le scoping tenant (`common/rbac/tenant-scope.ts`,
  `resolveTenantFilter`/`assertCompanyAccess`) dans `ClaimsService` et
  `RecoursModule` une fois ces modules réels — un `CORRESPONDANT_IDA`/
  `TRESORIER` ne doit voir que les dossiers de sa compagnie.

### 7. Intégrations externes

- `src/auth/strategies/keycloak.strategy.ts` : implémenter la vérification
  JWT (JWKS) + mapping rôle/companyId. Voir le TODO détaillé dans le
  fichier.
- `src/documents/providers/s3.provider.ts` : implémenter l'upload/
  présignature S3/MinIO réelle. Voir le TODO détaillé dans le fichier.
- Paperless (OCR/indexation) : non amorcé, à ajouter dans
  `DocumentsModule` (orchestration upload S3 → envoi Paperless → liaison
  au dossier).
- Redis : non branché. Prévoir un cache de lecture pour les dashboards
  (cockpit, métrologie) et les sessions une fois disponible.

## Vérifications effectuées dans ce socle

- `npm install` : OK (registre npm joignable dans cet environnement).
- `npx tsc --noEmit` : OK, aucune erreur.
- `npx nest build` : OK (sortie dans `dist/src/`).
- `npx jest` : 3/3 tests passent (`AdherentsService`, mode dégradé).
- Démarrage réel (`node dist/src/main.js`) **sans PostgreSQL/Redis/MinIO/
  Keycloak lancés** : démarre proprement, logge le mode dégradé, et tous
  les endpoints testés manuellement répondent (voir ci-dessous).
- RBAC vérifié manuellement : `AUDITEUR_CSA` reçoit bien 403 sur une
  action d'écriture (`POST /matching/:id/decide`) malgré toute dérogation;
  `CORRESPONDANT_IDA` (qui a `matchDecide`) reçoit 200.
- `GET /referential/wilayas` renvoie bien 69 entrées (codes 01→69) en
  mode dégradé (repli mémoire identique à la migration/seed).
