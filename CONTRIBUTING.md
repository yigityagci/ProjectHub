# Contributing to ProjectHub

Thanks for your interest in contributing! ProjectHub is an open-source,
self-hosted project management platform (Apache-2.0). This document
covers local setup, branch/PR conventions, style/testing expectations, and
how the project is organized. By participating, you're expected to follow
the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

1. Fork and clone the repository.
2. Install dependencies: `corepack enable && pnpm install`.
3. For local (non-Docker) development, follow the "Local development"
   section of [`README.md`](README.md) - it covers running Postgres/Redis,
   applying migrations, and starting the API and web dev servers. For a
   full Docker Compose walkthrough (including creating the first admin
   account, a workspace, and a project end-to-end), see the "Self-host
   smoke test" section of `README.md`.
4. Copy `.env.example` to `.env` and fill in local values (see
   `docs/PRODUCTION.md` for what each variable does and which ones matter
   for a real deployment vs. local dev).
5. Run the API test suite before making any changes, to confirm a clean
   baseline: `pnpm test` (equivalent to
   `pnpm --filter @projecthub/api run test`).

## Project structure

This is a pnpm workspaces monorepo:

```
apps/
  api/      Fastify + Prisma backend (@projecthub/api)
  web/      React + Vite frontend (@projecthub/web)
packages/
  shared/   Shared types, Zod DTOs, RBAC permission/role catalog (@projecthub/shared)
docs/
  ARCHITECTURE.md          Full architecture, data model, and security risk register
  PHASES.md                Phase-by-phase roadmap and what's delivered in each
  PRODUCTION.md            Production deployment / reverse-proxy / troubleshooting guide
  BACKUP_AND_RESTORE.md    Backup/restore procedure
scripts/
  backup.sh / restore.sh   Database + uploads backup/restore scripts
```

Within `apps/api/src`, each module (`auth/`, `rbac/`, `workspaces/`,
`projects/`, `activity/`, `analytics/`, `notifications/`, `attachments/`,
`comments/`, `realtime/`, `storage/`, `audit/`, `core/`, `config/`) is a
self-contained, Fastify-plugin-shaped unit. New backend features should
follow the same shape: a `*.routes.ts` (Fastify route registration +
request parsing/serialization) alongside a `*.service.ts` (business logic,
Prisma queries) - look at an existing module doing something similar
before inventing a new pattern.

## Development guidelines

- **TypeScript everywhere.** Shared types/DTOs live in `packages/shared`
  and are the single source of truth for request/response shapes used by
  both `apps/api` and `apps/web`.
- **Never trust client input for authorization-relevant fields.**
  `workspaceId`, `role`, `ownerId`, `id`, `createdById`, `version`, and
  similar fields must always be derived from the authenticated
  session/URL context, never taken from a request body or query string.
  Use `.strict()` Zod schemas everywhere so unexpected fields are rejected
  outright rather than silently ignored.
- **Workspace isolation is non-negotiable.** Any new route under
  `/api/workspaces/:workspaceId/...` must go through the
  `requireMembership` guard (and `requireProjectAccess` too, for anything
  under `.../projects/:projectId/...`); any deeper query must filter by
  `workspaceId` (and `projectId` where applicable) - never rely on a
  client-supplied id alone.
- **Unauthorized workspace/project access returns `404`, not `403`** (see
  `docs/ARCHITECTURE.md`'s security risk register, items 1 and 13) - this
  keeps an unauthorized caller from being able to distinguish "this
  resource doesn't exist" from "it exists but you can't see it."
- **Search/filter/list query parameters compose with, never replace,
  existing scoping.** If you add a new filterable field to a list
  endpoint, it must `AND` onto the existing `workspaceId`/`projectId`/
  access-visibility clauses, never provide an alternate path to the same
  data.
- **Audit log metadata must be allowlisted**, never raw request bodies,
  and must never contain secrets/tokens/passwords.
- **Match existing conventions before introducing new ones** - CSS class
  names follow the `ph-*` prefix convention (`apps/web/src/styles.css`),
  colors route through the CSS custom properties there (not hardcoded hex
  values, so light/dark theming stays correct), and the frontend
  deliberately uses no component/UI library beyond what's already a
  dependency (`@dnd-kit`, `socket.io-client`) - don't add a new one without
  discussing it first.

### Security expectations for contributions

Given this project's threat model (see `docs/ARCHITECTURE.md` section 1 -
workspace isolation is an in-app authorization problem, not an
infrastructure one), any PR that touches authorization, RBAC, or
cross-resource access should:

- Include a test mirroring the isolation-test patterns already in
  `apps/api/test/` (e.g. `workspace-isolation.test.ts`,
  `project-access-isolation.test.ts`, `search-and-filter.test.ts`) proving
  a cross-workspace or cross-project access attempt is denied.
- Not introduce a new way to distinguish "doesn't exist" from "exists but
  you can't see it" (i.e., keep returning `404`, not `403`, for denied
  access to a specific resource by id).

See [`SECURITY.md`](SECURITY.md) for how to report an actual vulnerability
you've found (never in a public issue/PR).

## Running the test suite

```bash
pnpm test                 # equivalent to: pnpm --filter @projecthub/api run test
pnpm --filter @projecthub/web run build   # type-checks + builds the frontend
pnpm --filter @projecthub/api run lint    # tsc --noEmit
```

The API test suite is integration-style (Vitest + Fastify's `inject()`)
against a real PostgreSQL + Redis instance, configured via the
`DATABASE_URL`/`REDIS_URL` environment variables (see
`apps/api/test/setup.ts`). There is no mocking of the database or Redis -
tests exercise the real authorization/persistence path end-to-end.

New backend behavior should include tests. Frontend styling/theming/
responsive-layout changes and documentation changes are not expected to
have automated tests - those are reviewed by inspection.

## Commit / PR process

- Keep pull requests focused on a single feature/fix where possible.
- Include or update tests for any behavioral change (see above).
- Write commit messages that explain *why*, not just *what* - a one- or
  two-line summary is fine; there's no required prefix/format (e.g. no
  mandatory Conventional Commits), but be descriptive.
- Do not commit `.env` files, real credentials, or any other secret.
- If your change affects a phase's delivered scope, update the relevant
  section of `docs/PHASES.md` to keep it accurate.
- Branch naming has no strict required convention; a short, descriptive
  name (e.g. `fix/task-move-race`, `feat/search-filters`) is appreciated
  but not enforced.

## Reporting bugs / security issues

- Regular bugs: open a GitHub issue with steps to reproduce.
- Security vulnerabilities: see [`SECURITY.md`](SECURITY.md) - do **not**
  open a public issue or PR for these.
