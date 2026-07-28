# ProjectHub

ProjectHub is an open-source, self-hosted project management platform. It
lets individuals, teams, and companies run their own project management
tool without depending on a third-party SaaS provider.

This repository currently implements **Phase 1**: the authentication,
multi-workspace, and role-based access control (RBAC) foundation. See
[`docs/PHASES.md`](docs/PHASES.md) for the full phase roadmap and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the architecture,
data model, and security design.

## Quick start (Docker Compose)

```bash
git clone <this-repo-url> projecthub
cd projecthub
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD and APP_SECRET to strong random values.
docker-compose up -d
```

This brings up the database, Redis, the API, and the web UI. Once the
`api` and `web` containers report healthy (`docker-compose ps`):

- Open `http://localhost:5173` in a browser — this is the web UI. Because
  no user exists yet, you'll land on a setup page to create the first
  administrator account (this calls `POST /api/setup` under the hood).
- The API itself is available at `http://localhost:4000`. Visit `GET /health`
  and `GET /health/ready` to confirm liveness/readiness directly.

If you change `APP_URL` in `.env` after the first build (e.g. because
you're deploying behind a different public hostname), rebuild the web
image so the new value is baked into the browser bundle:

```bash
docker-compose build web
docker-compose up -d
```

## Local development (without Docker)

Requirements: Node.js 20+, pnpm, a local PostgreSQL 16 instance, and a
local Redis instance.

```bash
corepack enable
pnpm install
cp apps/api/.env.example apps/api/.env   # if present, otherwise see .env.example
pnpm --filter @projecthub/api run prisma:migrate
pnpm dev:api    # starts the API on http://localhost:4000
pnpm dev:web    # starts the minimal frontend on http://localhost:5173
```

## Running tests

```bash
pnpm --filter @projecthub/api run test
```

The API test suite is integration-style (Vitest + Fastify's `inject()`)
against a real PostgreSQL + Redis instance, configured via the
`DATABASE_URL` / `REDIS_URL` environment variables (see
`apps/api/test/setup.ts`).

## Repository layout

```
apps/
  api/      Fastify + Prisma backend (@projecthub/api)
  web/      Minimal React + Vite frontend (@projecthub/web)
packages/
  shared/   Shared types, Zod DTOs, RBAC permission/role catalog (@projecthub/shared)
docs/
  ARCHITECTURE.md   Full architecture, data model, and security risk register
  PHASES.md         Phase-by-phase roadmap (Phase 1 implemented, 2-8 planned)
```

## License

ProjectHub is licensed under the [Apache License 2.0](LICENSE). See
[NOTICE](NOTICE) for attribution.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
