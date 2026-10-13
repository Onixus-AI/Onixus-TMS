# Build from the repo root: docker build -f apps/web/Dockerfile .
# The VITE_ variables are public: they are baked into the browser bundle.
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/providers/package.json packages/providers/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @onixus/web --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/web apps/web
ARG VITE_API_URL
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
RUN npm run build --workspace @onixus/web

FROM caddy:2-alpine
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
