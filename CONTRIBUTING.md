# Contributing to ProjectHub

Thanks for your interest in contributing! ProjectHub is an open-source,
self-hosted project management platform (Apache 2.0). This document is a
stub for Phase 1 and will be expanded with detailed style/testing
conventions in Phase 8.

## Getting started

1. Fork and clone the repository.
2. Install dependencies: `corepack enable && pnpm install`.
3. Copy `.env.example` to `.env` (and `apps/api/.env` for local dev) and
   fill in local values.
4. Run the API test suite before making changes to confirm a clean
   baseline: `pnpm --filter @projecthub/api run test`.

## Project structure

This is a pnpm workspaces monorepo. See the "Repository layout" section
of [`README.md`](README.md).

## Development guidelines

- **TypeScript everywhere.** Shared types/DTOs live in
  `packages/shared` and should be the single source of truth for
  request/response shapes used by both `apps/api` and `apps/web`.
- **Never trust client input for authorization-relevant fields.**
  `workspaceId`, `role`, `ownerId`, `id`, `createdById`, and similar
  fields must always be derived from the authenticated session/URL
  context, never taken from a request body. Use `.strict()` Zod schemas
  so unexpected fields are rejected outright.
- **Workspace isolation is non-negotiable.** Any new route under
  `/api/workspaces/:workspaceId/...` must go through the
  `requireMembership` guard, and any deeper query must filter by
  `workspaceId`.
- **Unauthorized workspace access returns 404, not 403** (see
  `docs/ARCHITECTURE.md` security risk register, item 1 and 13).
- **Write tests for security-relevant behavior.** New endpoints that
  touch authorization, RBAC, or workspace isolation should include tests
  mirroring the patterns in `apps/api/test/`.
- **Audit log metadata must be allowlisted**, never raw request bodies,
  and must never contain secrets/tokens/passwords.

## Commit / PR process

- Keep pull requests focused on a single phase/feature where possible.
- Include or update tests for any behavioral change.
- Do not commit `.env` files or other secrets.

## Reporting bugs / security issues

- Regular bugs: open a GitHub issue.
- Security vulnerabilities: see [SECURITY.md](SECURITY.md) — do not open
  a public issue.
