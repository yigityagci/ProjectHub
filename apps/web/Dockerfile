# ProjectHub web (SPA) - production image
# Multi-stage build: build the Vite production bundle, then serve the
# static output from a minimal, non-root runtime image.

FROM node:20-bookworm-slim AS base
RUN corepack enable
WORKDIR /workspace

FROM base AS build

# Public URL of the API, as reachable from users' browsers (NOT the
# internal Docker network hostname). Vite env vars are inlined into the
# JS bundle at build time, so changing this later requires rebuilding
# this image. Defaults match APP_URL in .env.example.
ARG VITE_API_URL=http://localhost:4000
ENV VITE_API_URL=${VITE_API_URL}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
# Sibling workspace member's package.json only (never its source) — see
# apps/api/Dockerfile's identical comment for why this is required now
# that apps/mail-control is a third workspace member.
COPY apps/mail-control/package.json ./apps/mail-control/package.json
RUN pnpm install --frozen-lockfile --filter @projecthub/shared --filter @projecthub/web
RUN pnpm --filter @projecthub/shared run build
RUN pnpm --filter @projecthub/web run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace/apps/web

# `serve` is a small, well-known static file server with built-in SPA
# fallback support (-s / --single rewrites unknown paths to index.html),
# which this React Router app needs. Pinned to a specific version for
# reproducible builds.
RUN npm install -g serve@14.2.6

COPY --from=build --chown=node:node /workspace/apps/web/dist ./dist

USER node
EXPOSE 5173

HEALTHCHECK --interval=10s --timeout=5s --retries=10 --start-period=10s \
  CMD node -e "fetch('http://localhost:5173/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["serve", "-s", "-l", "5173", "dist"]
