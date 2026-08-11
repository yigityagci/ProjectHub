# ProjectHub API - production image
# Multi-stage build: install + build in one stage, run in a slim stage.

FROM node:20-bookworm-slim AS base
# bookworm-slim strips OpenSSL, so Prisma's engine binaries can't detect
# which libssl variant is present and silently fall back to a mismatched
# one (openssl-1.1.x on an openssl3-only base) -- the schema/query engine
# then fails to even load, with no useful error message. Installing it
# here (before `prisma generate` runs in the build stage) fixes detection
# for both that stage and the runtime stage below, since both `FROM base`.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /workspace

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
# Sibling workspace member's package.json only (never its source) — pnpm
# resolves the full workspace graph from pnpm-lock.yaml before filtering,
# so every apps/* package.json must be present at install time even when
# --filter only builds this one. Required since apps/mail-control was
# added as a new workspace member; omitting this line breaks this
# install with ERR_PNPM_OUTDATED_LOCKFILE.
COPY apps/mail-control/package.json ./apps/mail-control/package.json
RUN pnpm install --frozen-lockfile --filter @projecthub/shared --filter @projecthub/api
RUN pnpm --filter @projecthub/shared run build
RUN pnpm --filter @projecthub/api run prisma:generate
RUN pnpm --filter @projecthub/api run build
# pnpm's isolated node_modules layout resolves @prisma/client (and the
# `prisma generate` output alongside it, `.prisma/client`) into a
# content-hashed directory inside the shared `.pnpm` store
# (node_modules/.pnpm/@prisma+client@<ver>_prisma@<ver>/node_modules/), NOT
# directly under apps/api/node_modules — apps/api/node_modules/@prisma is
# only a symlink into that store. The runtime stage below does its own
# fresh --prod install (to avoid shipping devDependencies), which recreates
# an IDENTICALLY-hashed store directory (same locked versions -> same pnpm
# content hash) containing the real @prisma/client package but WITHOUT the
# generated .prisma/client output, since that's produced by `prisma
# generate` (a devDependency-only step), not part of the npm package.
# Extracting it here to a fixed, version-hash-independent path lets the
# runtime stage below inject it into its own (differently-pathed only in
# theory, identically-pathed in practice) store directory without either
# stage ever hardcoding that hash.
RUN PRISMA_NM_DIR="$(dirname "$(dirname "$(realpath apps/api/node_modules/@prisma/client)")")" \
  && mkdir -p /prisma-generated \
  && cp -r "$PRISMA_NM_DIR/.prisma" /prisma-generated/.prisma

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/prisma ./apps/api/prisma
COPY apps/mail-control/package.json ./apps/mail-control/package.json
RUN pnpm install --frozen-lockfile --prod --filter @projecthub/shared --filter @projecthub/api

COPY --from=build /workspace/apps/api/dist ./apps/api/dist
# See the build stage's matching comment above: injects the `prisma
# generate` output (missing from this stage's own --prod install, since
# generation is a devDependency-only step) into this stage's own
# identically-hashed pnpm store directory for @prisma/client — never a
# hardcoded content-hash path on either side.
COPY --from=build /prisma-generated/.prisma /tmp/prisma-generated/.prisma
# `.prisma/` already exists here (this stage's own --prod install of
# @prisma/client creates it, as an "I haven't been generated yet" stub) --
# `cp -r SRC DEST` copies SRC *inside* an already-existing DEST rather than
# merging into it, which silently produced a broken double-nested
# `.prisma/.prisma/client/...` (engine binary present, but not where the
# generated client code looks for it -> "did not initialize yet" at
# startup). The trailing `/.` on SRC copies its *contents* into DEST
# instead, regardless of whether DEST pre-exists.
RUN PRISMA_NM_DIR="$(dirname "$(dirname "$(realpath apps/api/node_modules/@prisma/client)")")" \
  && mkdir -p "$PRISMA_NM_DIR/.prisma" \
  && cp -r /tmp/prisma-generated/.prisma/. "$PRISMA_NM_DIR/.prisma/" \
  && rm -rf /tmp/prisma-generated

WORKDIR /workspace/apps/api

EXPOSE 4000

# Apply pending migrations, then start the server. `prisma migrate deploy`
# is the safe, non-interactive migration command intended for production.
#
# Run via tsx, not plain `node`: apps/api's own `tsc` build (unlike apps/web's
# Vite bundle) never inlines cross-package imports -- dist/index.js still has
# a bare `import ... from "@projecthub/shared"`, which Node's runtime module
# resolution follows to that package's package.json `main`
# (`./src/index.ts`), raw TypeScript that plain `node` cannot load at all.
# tsx transpiles any .ts file its loader hook encounters, entry point or not,
# so it resolves that import correctly without requiring @projecthub/shared
# to ship (or this image to inject) a separate built dist/ output of its own.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node_modules/.bin/tsx dist/index.js"]
