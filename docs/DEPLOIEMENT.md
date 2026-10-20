# IDA Place — Déploiement en production

Document de référence de la chaîne de déploiement (constat SEC-23 de la revue
de sécurité du 2026-10-19). Il complète `.env.production.example` (API) et
`.env.production.example` du frontend. **Le Tech Lead le complète après
fusion des branches de sécurité** (section « À compléter » en fin de
document). Mis à jour le 2026-10-20 après la phase 2 d'intégration.

## 1. Architecture cible

```
Internet
   │  443/TCP uniquement (TLS 1.2+, HSTS)
   ▼
┌─────────────────────────────┐   zone exposée (DMZ)
│ Reverse proxy TLS           │   seul composant joignable depuis Internet
│ (nginx / HAProxy / Traefik) │   - app.<domaine>  → frontend :3000
│                             │   - api.<domaine>  → API :3001 (HTTP + WebSocket /realtime)
└──────────────┬──────────────┘   - auth.<domaine> → Keycloak :8080
               │ réseau privé (aucun port publié sur l'hôte)
   ┌───────────┼──────────────┬───────────────────┐
   ▼           ▼              ▼                   ▼
frontend    API NestJS     Keycloak          job de migration
(non-root)  (non-root)     (realm ida-place)  (ponctuel, rôle DB dédié)
               │
   réseau données (privé, filtré : seule l'API y accède)
   ┌───────────┼──────────────┬───────────────────┐
   ▼           ▼              ▼
PostgreSQL   Redis          Stockage objet S3
(TLS)        (mot de passe, (TLS, bucket privé,
             TLS, ACL)      URL pré-signées courtes)
```

Règles :

- **Seul le reverse proxy est exposé.** API, frontend, Keycloak (hors
  `/realms/ida-place/…` publié par le proxy), PostgreSQL, Redis et le
  stockage objet ne publient aucun port sur une interface publique.
  La console d'administration Keycloak (`/admin`) n'est accessible que
  depuis le réseau d'administration (VPN), jamais via le proxy public.
- **TLS partout** : terminaison TLS au proxy (certificats gérés,
  renouvellement automatique, TLS 1.2 minimum, suites modernes, HSTS
  `max-age=63072000; includeSubDomains`), TLS de l'API vers PostgreSQL
  (`DB_SSL=true`, CA vérifiée), Redis en `rediss://`, S3 en `https://`.
- **En-têtes transmis par le proxy** : `X-Forwarded-For`,
  `X-Forwarded-Proto` ; `TRUST_PROXY_HOPS` = nombre exact de proxys de
  confiance devant l'API (1 dans le schéma ci-dessus), sans quoi la
  limitation de débit compterait l'adresse du proxy.
- **WebSocket** : le proxy relaie `Upgrade`/`Connection` pour
  `api.<domaine>/socket.io/` (namespace `/realtime`) ; délai d'inactivité
  ≥ 60 s.
- **Taille des requêtes** : limiter le corps au proxy (ex. 10 Mo pour les
  imports/pièces jointes), en cohérence avec les limites de l'API (413).
- **Sondes** : vivacité `GET /api/v1/health/live` (processus), disponibilité
  `GET /api/v1/health/ready` (échoue sans base : le proxy / l'orchestrateur
  retire l'instance du trafic). Le frontend expose `GET /auth/logged-out`
  (page statique sans donnée) pour sa propre vivacité.

## 2. Images et chaîne CI/CD

| Dépôt | Image | Contenu | Utilisateur |
|---|---|---|---|
| backend | `Dockerfile` (cible `runtime`, défaut) | `dist/` sans source map, dépendances de production seulement, sans npm | `node` (uid 1000) |
| backend | `Dockerfile` (cible `migrator`) | build complet + CLI MikroORM, `migration:up` | `node` (uid 1000) |
| frontend | `Dockerfile` | `output: 'standalone'`, sans source map ni mode dev, sans npm | `nextjs` (uid 1001) |

- Construire l'API : `docker build -t ida-place-api:<version> .` ; le job de
  migration : `docker build --target migrator -t ida-place-api-migrator:<version> .`
- Construire le frontend (variables inlinées au build, une image par
  environnement) :
  `docker build --build-arg NEXT_PUBLIC_API_URL=https://api.<domaine> --build-arg NEXT_PUBLIC_KEYCLOAK_URL=https://auth.<domaine> -t ida-place-frontend:<version> .`
  Le build échoue si la configuration n'est pas en Keycloak + https.
- Épingler les images de base par empreinte (`node:22-alpine@sha256:…` pour
  l'API comme pour le frontend), les reconstruire à
  chaque correctif de sécurité de Node/Alpine, et scanner les images
  (Trivy/Grype) avant publication dans le registre privé.
- Le système de fichiers des conteneurs peut être monté en lecture seule
  (`read_only: true`), avec un `tmpfs` sur `/tmp` ; `no-new-privileges`,
  toutes les capabilities retirées (`cap_drop: [ALL]`).
- CI (`.github/workflows/ci.yml` des deux dépôts) : `npm ci --ignore-scripts`,
  lint, tests unitaires, e2e (`AUTH_PROVIDER=dev`, `NODE_ENV=test`), build,
  `npm run audit:gate` bloquant (avis élevés/critiques non analysés ; exceptions datées dans `security/audit-exceptions.json`), gitleaks sur tout
  l'historique, build des images. Activer en plus Dependabot ou Renovate.
- **Migrations** : jamais au démarrage de l'API. Ordre de mise en production :
  sauvegarde → job `migrator` (rôle PostgreSQL de migration, propriétaire du
  schéma) → déploiement de l'API (rôle applicatif restreint) → frontend.
  `migration:down` et le seeder sont refusés en production sans
  `ALLOW_PRODUCTION_DESTRUCTIVE=true` posé explicitement pour l'opération.

> Note : le `package-lock.json` de l'API a été régénéré avec npm 10 le
> 2026-10-20 (une seule entrée ajoutée, aucune version de dépendance
> modifiée) : `npm ci` passe avec le npm 10 de Node 22 comme avec npm 11.
> L'image et la CI de l'API sont revenues sur Node 22 LTS (`engines.node >= 22`).

## 3. Secrets

- Toutes les valeurs `<secret>` viennent d'un **coffre de secrets** (Vault,
  coffre du fournisseur cloud, secrets Kubernetes chiffrés) injecté au
  démarrage ; jamais dans le dépôt, l'image, les logs ni les variables de
  build du frontend (qui ne reçoit que des URL publiques).
- Fichiers sensibles (CA PostgreSQL) montés en lecture seule, ex.
  `/run/secrets/postgres-ca.pem`.
- Rotation : `LEDGER_HMAC_KEY` (avec procédure de continuité du journal
  scellé), mots de passe PostgreSQL/Redis, clés S3 ; `KEYCLOAK` : rotation
  des clés de signature du realm (l'API recharge le JWKS sur `kid` inconnu).
- `DEV_JWT_SECRET` n'est **pas** utilisé en production (`AUTH_PROVIDER=keycloak`).
- `EXPERT_RIB_KEY` (32 octets, base64) chiffre les RIB des experts
  (AES-256-GCM, enveloppe `v1:`). La perdre rend les RIB illisibles :
  la conserver dans le coffre avec sauvegarde. Sa rotation impose de
  déchiffrer avec l'ancienne clé puis rechiffrer avec la nouvelle (outil à
  écrire, non fourni : prévoir l'opération avant toute rotation).
- Il n'existe **aucun** secret de signature de documents : S3 signe ses
  URL pré-signées avec ses propres identifiants ; en mode local
  (développement), les pièces passent par la route authentifiée
  `GET /api/v1/documents/:id/download`, contrôlée à chaque requête.

## 4. Base de données, Redis, stockage

- PostgreSQL 16 managé ou durci : réseau privé, `ssl=on`, `pg_hba` en
  `hostssl` uniquement, deux rôles — migration (propriétaire du schéma) et
  applicatif (`ida_place_app`, droits minimaux ; `SELECT/INSERT` seulement
  sur le journal scellé). `DB_SSL_REJECT_UNAUTHORIZED=true` obligatoire.
- **Sauvegardes** : sauvegarde complète quotidienne + archivage continu des
  WAL (PITR), chiffrées, copiées hors site / autre zone, rétention conforme
  aux obligations de conservation (à fixer avec l'UAR) ; **test de
  restauration** au moins trimestriel, y compris la vérification d'intégrité
  du journal scellé (`GET /api/v1/ledger/verify`) après restauration.
  Sauvegarder aussi le bucket S3 (versionnement + réplication) et
  l'export du realm Keycloak.
- Redis (si `REDIS_ENABLED=true`) : `requirepass`/ACL dédiée, TLS
  (`rediss://`), pas de persistance de données métier, `protected-mode yes`.
- Stockage objet : bucket privé, chiffrement au repos, politique d'accès
  limitée à l'API, URL pré-signées de courte durée.

## 5. Variables d'environnement de production

### 5.1 API (injectées au démarrage)

| Variable | Valeur de production | Obligatoire |
|---|---|---|
| `NODE_ENV` | `production` | oui |
| `PORT` | `3001` | non (défaut 3001) |
| `API_PREFIX` | `api/v1` | non |
| `AUTH_PROVIDER` | `keycloak` (tout autre valeur refusée au démarrage) | oui |
| `KEYCLOAK_BASE_URL` | `https://auth.<domaine>` | oui |
| `KEYCLOAK_REALM` | `ida-place` | oui |
| `KEYCLOAK_CLIENT_ID` | `ida-place-api` | oui |
| `KEYCLOAK_ALLOWED_CLIENTS` | `ida-place-web` (clients `azp` acceptés) | oui |
| `DB_HOST` / `DB_PORT` / `DB_NAME` | hôte privé, `5432`, `ida_place` | oui |
| `DB_USER` / `DB_PASSWORD` | rôle applicatif / `<secret>` | oui |
| `DB_SSL` | `true` | oui |
| `DB_SSL_CA` | chemin du certificat de l'AC (ex. `/run/secrets/postgres-ca.pem`) | recommandé |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` | oui |
| `DB_DEBUG` | absent / `false` (journalisation SQL interdite en production) | non |
| `LEDGER_HMAC_KEY` | `<secret>` ≥ 32 caractères, hors base | oui |
| `EXPERT_RIB_KEY` | `<secret>` 32 octets en base64 (ou 64 caractères hex) ; absente = saisie de RIB refusée | oui si des RIB sont saisis |
| `REDIS_ENABLED` | `true` / `false` | non |
| `REDIS_URL` | `rediss://:<secret>@<hôte>:6380` (mot de passe obligatoire en production) | si Redis |
| `S3_ENABLED` | `true` | oui en production |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` | `https://…`, région, bucket privé | oui |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `<secret>` | oui |
| `S3_SSE` | `AES256` (défaut) ou `aws:kms` ; `none` refusé en production | non |
| `S3_SSE_KMS_KEY_ID` | identifiant de la clé KMS si `S3_SSE=aws:kms` | si KMS |
| `ANTIVIRUS_MODE` | `clamd` (recommandé) ou `disabled` (défaut) | recommandé |
| `CLAMD_HOST` / `CLAMD_PORT` / `CLAMD_TIMEOUT_MS` | démon ClamAV privé, `3310`, `15000` ; injoignable = dépôt refusé (503) | si `clamd` |
| `LOCAL_STORAGE_DIR` | non utilisé en production (stockage S3) | non |
| `CORS_ORIGIN` | `https://app.<domaine>` (jamais `*`) | oui |
| `TRUST_PROXY_HOPS` | nombre de proxys de confiance (`1`) | oui |
| `THROTTLE_ENABLED` | non désactivable en production | non |
| `THROTTLE_LIMIT` / `THROTTLE_TTL_SECONDS` | ex. `300` / `60` | non |
| `THROTTLE_IMPORT_LIMIT` / `THROTTLE_IMPORT_TTL_SECONDS` | `POST /claims/import` : défaut `10` / `60` | non |
| `THROTTLE_UPLOAD_LIMIT` / `THROTTLE_UPLOAD_TTL_SECONDS` | `POST /documents/upload` : défaut `30` / `60` | non |
| `THROTTLE_LEDGER_VERIFY_LIMIT` / `THROTTLE_LEDGER_VERIFY_TTL_SECONDS` | `GET /ledger/verify` : défaut `6` / `60` | non |
| `THROTTLE_ADMIN_LIMIT` / `THROTTLE_ADMIN_TTL_SECONDS` | `/admin/users*`, `/admin/roles/matrix`, `PUT /pricing/grid` : défaut `30` / `60` | non |
| `IMPORT_MAX_ROWS` | plafond de lignes de données par import (défaut 5 000) | non |
| `IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES` / `IMPORT_XLSX_MAX_COMPRESSION_RATIO` / `IMPORT_XLSX_MAX_ENTRIES` | bornes anti-bombe zip des XLSX (défauts 50 Mo / 100 / 500) | non |
| `ANALYSIS_MAX_CLAIMS` | dossiers chargés au plus pour les agrégats (défaut 100 000) | non |
| `SWAGGER_ENABLED` | absent (Swagger désactivé ; `true` l'exposerait) | non |
| `LOG_JSON` | `true` (journaux structurés vers la collecte centralisée) | recommandé |
| `ALLOW_PRODUCTION_DESTRUCTIVE` | absent ; `true` seulement le temps d'un `migration:down`/seeder validé | non |
| `ELIGIBILITY_GRID_VERSION`, `ELIGIBILITY_MAX_AMOUNT_DA`, `ELIGIBILITY_RECOURS_MAX_MONTHS` | paramètres conventionnels (valeurs validées UAR) | selon convention |
| `MATCHING_AUTO_THRESHOLD`, `MATCHING_CONFIRM_THRESHOLD` | seuils d'appariement | selon convention |
| `RECOURS_OPPOSITION_DAYS`, `RECOURS_SILENCE_DAYS` | délais conventionnels | selon convention |
| `RECOURS_SWEEP_INTERVAL_MINUTES` | balayage des délais de recours (défaut `60`, `0` = désactivé) | non |
| `COMMISSION_PENALTY_MAX_DA` | plafond des pénalités (défaut : `ELIGIBILITY_MAX_AMOUNT_DA`) | selon décision UAR |
| `MEMBERSHIP_RECEIVED_MAX_AGE_DAYS` | antériorité maximale d'un courrier d'adhésion/retrait (défaut 30 j, décision UAR SEC-47 attendue) | selon décision UAR |
| `FRAUD_RECURRENCE_WINDOW_DAYS`, `FRAUD_TRANSMISSION_LATE_DAYS`, `FRAUD_VELOCITY_SAME_DAY_THRESHOLD` | paramètres anti-fraude | selon convention |

Variables de **développement uniquement**, refusées ou ignorées en
production : `DEV_JWT_SECRET`, `AUTH_PROVIDER=dev`, `PAPERLESS_*` (intégration
non activée).

Job de migration : mêmes `DB_*` mais avec le **rôle de migration**, plus
`NODE_ENV=production`.

### 5.2 Frontend (arguments de build, publics)

| Variable | Valeur | Remarque |
|---|---|---|
| `NEXT_PUBLIC_AUTH_MODE` | `keycloak` (forcé par le Dockerfile) | tout autre valeur fait échouer le build |
| `NEXT_PUBLIC_API_URL` | `https://api.<domaine>` | https obligatoire ; WebSocket en `wss://` |
| `NEXT_PUBLIC_KEYCLOAK_URL` | `https://auth.<domaine>` | https obligatoire |
| `NEXT_PUBLIC_KEYCLOAK_REALM` | `ida-place` | |
| `NEXT_PUBLIC_KEYCLOAK_CLIENT_ID` | `ida-place-web` | client public PKCE |
| `NEXT_PUBLIC_DEV_USER` | **absent** | sa présence fait échouer le build |

Exécution du frontend : `PORT` (défaut 3000), `HOSTNAME=0.0.0.0` (déjà
fixés dans l'image).

### 5.3 Rechiffrement des RIB hérités (SEC-49)

Avant la remédiation, `expert.rib` était stocké en clair. L'API ne lit plus
ces valeurs (elle n'affiche que `rib_last4`) mais elles restent en base tant
qu'elles ne sont pas rechiffrées. Procédure, à exécuter une fois après la
migration `Migration20261020204000_ReferentielGouvernanceTrace` (colonne
`rib_last4`) et avant l'ouverture :

1. Sauvegarde de la base ; `EXPERT_RIB_KEY` créée dans le coffre et
   injectée à l'API **et** au job ci-dessous (même clé).
2. Inventaire, sans écriture (job `migrator`, rôle de migration) :
   `node dist/src/experts/rechiffrer-rib.cli.js`
   (en développement : `npm run experts:rechiffrer-rib`). Le script affiche
   le nombre et les identifiants des experts concernés, jamais les RIB.
3. Rechiffrement, en une transaction (`SELECT … FOR UPDATE`) :
   `node dist/src/experts/rechiffrer-rib.cli.js --apply`. Chaque RIB en
   clair devient une enveloppe `v1:` AES-256-GCM et `rib_last4` est
   renseigné ; idempotent (une enveloppe `v1:` n'est jamais retouchée).
4. Contrôle : `select count(*) from expert where rib is not null and rib not like 'v1:%';`
   doit renvoyer 0. Purger ensuite les sauvegardes antérieures contenant
   les RIB en clair selon la politique de conservation.

## 6. Keycloak (realm `ida-place`)

- Client `ida-place-web` : public, *Standard flow* seul, PKCE `S256`
  obligatoire, *Valid redirect URIs* `https://app.<domaine>/auth/callback`,
  *Valid post logout redirect URIs* `https://app.<domaine>/auth/logged-out`,
  *Web origins* `https://app.<domaine>`.
- Client `ida-place-api` : bearer-only / audience de l'API.
- Jetons : `typ=Bearer`, `email_verified=true`, **un seul** rôle applicatif
  (`ida_place_role` ou rôle de realm parmi les 6 rôles), attribut
  `company_id` mappé pour `CORRESPONDANT_IDA`/`TRESORIER`. Jeton d'accès
  court (≈ 5 min), rotation des jetons de rafraîchissement, durée de session
  SSO alignée sur la politique de l'UAR ; MFA recommandé pour les rôles de
  place.

## 7. Liste de contrôle avant ouverture

- [ ] Seul le port 443 du reverse proxy est joignable depuis Internet (scan externe).
- [ ] `curl -I https://app.<domaine>/cockpit` : CSP avec nonce, HSTS, `nosniff`, pas de `X-Powered-By`.
- [ ] `GET https://api.<domaine>/api/docs` → 404 ; requête avec `x-dev-user` sans jeton → 401.
- [ ] `/api/v1/health/ready` → 200 ; conteneurs « healthy », non-root.
- [ ] Connexion, renouvellement et déconnexion Keycloak de bout en bout.
- [ ] Sauvegarde et restauration testées ; `/api/v1/ledger/verify` valide après restauration.
- [ ] Alertes : 5xx, 429 anormaux, échecs de vérification du journal, expiration des certificats.

## 8. À compléter par le Tech Lead après fusion

- Fait en phase 2 (2026-10-20) : `DOCUMENT_SIGNING_SECRET` retiré (il
  n'existe pas, voir § 3) ; variables des branches `security/*` reportées
  ci-dessus et dans `.env.example` / `.env.production.example` ;
  `REDIS_URL` de développement aligné sur le `docker-compose.yml` ;
  lockfile régénéré, image et CI revenues sur Node 22.
- Choisir l'orchestrateur (Compose durci, Kubernetes…) et y reporter les
  options de la section 2 (lecture seule, `cap_drop`, réseaux).
