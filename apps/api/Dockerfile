# ProjectHub API - production image
# Multi-stage build: install + build in one stage, run in a slim stage.

FROM node:20-bookworm-slim AS base
RUN corepack enable
WORKDIR /workspace

FROM base AS build
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @projecthub/shared --filter @projecthub/api
RUN pnpm --filter @projecthub/shared run build
RUN pnpm --filter @projecthub/api run prisma:generate
RUN pnpm --filter @projecthub/api run build

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /workspace

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/prisma ./apps/api/prisma
RUN pnpm install --frozen-lockfile --prod --filter @projecthub/shared --filter @projecthub/api

COPY --from=build /workspace/apps/api/dist ./apps/api/dist
COPY --from=build /workspace/apps/api/node_modules/.prisma ./apps/api/node_modules/.prisma
COPY --from=build /workspace/apps/api/node_modules/@prisma ./apps/api/node_modules/@prisma

WORKDIR /workspace/apps/api

EXPOSE 4000

# Apply pending migrations, then start the server. `prisma migrate deploy`
# is the safe, non-interactive migration command intended for production.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/index.js"]
