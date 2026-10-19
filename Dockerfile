# syntax=docker/dockerfile:1.7
# IDA Place — API NestJS (SEC-23).
#
# Cibles :
#   - runtime (défaut) : dist/ compilé SANS source maps + dépendances de
#     production uniquement, utilisateur non-root, NODE_ENV=production.
#   - migrator : job ponctuel `mikro-orm migration:up` (rôle PostgreSQL de
#     migration), jamais exécuté au démarrage de l'API.
#
#   docker build -t ida-place-api .
#   docker build --target migrator -t ida-place-api-migrator .
#
# Aucune variable d'environnement ni secret n'est intégré à l'image : tout est
# injecté au démarrage par l'orchestrateur / le coffre de secrets (voir
# docs/DEPLOIEMENT.md). En production, épingler l'image de base par empreinte
# (node:22-alpine@sha256:…).
#
# Node 22 LTS (`engines.node >= 22`, `@types/node` 22) : le package-lock.json
# a été régénéré avec npm 10 (2026-10-20) et passe `npm ci` avec le npm 10 de
# Node 22 comme avec le npm 11 de Node 24 (auparavant : « Missing:
# webpack@5.112.0 from lock file »).
ARG NODE_IMAGE=node:22-alpine

# ---------- 1. Dépendances complètes (build, migrations) ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV SCARF_ANALYTICS=false
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# ---------- 2. Dépendances de production uniquement ----------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
ENV SCARF_ANALYTICS=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# ---------- 3. Compilation ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Aucune source map ni métadonnée de compilation incrémentale dans l'image.
RUN npm run build \
 && find dist -name "*.map" -delete \
 && find dist -name "*.tsbuildinfo" -delete \
 && test -f dist/src/main.js

# ---------- 4. Job de migration (cible explicite) ----------
FROM build AS migrator
ENV NODE_ENV=production
RUN chown -R node:node /app
USER node
CMD ["npx", "mikro-orm", "migration:up"]

# ---------- 5. Exécution de l'API (cible par défaut) ----------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    SCARF_ANALYTICS=false
# Ni npm ni yarn à l'exécution : surface réduite.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
# Code en lecture seule pour l'utilisateur d'exécution (uid 1000 « node »).
USER node
EXPOSE 3001
# Vivacité du processus ; la disponibilité (base joignable) se contrôle par
# /api/v1/health/ready côté orchestrateur / reverse proxy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
