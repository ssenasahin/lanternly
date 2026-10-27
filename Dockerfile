# One build for the whole workspace; deployments/compose.yml runs its stages as
# the api, the worker, the migration step and the web server.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Prisma's engines need OpenSSL to be present when the client is generated.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
# Manifests first, so the dependency layer is reused until a package.json changes.
COPY package.json package-lock.json ./
COPY db/package.json db/
COPY api/package.json api/
COPY worker/package.json worker/
COPY agent/package.json agent/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

# The api, the worker and the migration step. The Prisma CLI stays in the image
# because `migrate` applies the migrations with it on every deploy.
FROM node:22-bookworm-slim AS app
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app /app
USER node

# The static dashboard behind Caddy, which also proxies /api to the api container
# so the browser sees one origin and the refresh cookie stays first-party.
FROM caddy:2-alpine AS web
COPY --from=build /app/web/dist /srv
COPY deployments/Caddyfile /etc/caddy/Caddyfile
