# ProjectHub Architecture

This document transcribes the Phase 0 architecture analysis for
ProjectHub: constraints and risks, technology selection, the full target
data model (all phases), and the security risk register. Phase-by-phase
scope is documented separately in [`PHASES.md`](PHASES.md).

## 1. Key constraints and risks

ProjectHub is a self-hosted, multi-tenant-within-a-single-deployment
collaboration app. The "tenants" are **workspaces**, but unlike SaaS
multi-tenancy, all workspaces live in one database owned by the person
self-hosting. The operator is trusted, but users of a workspace are
**not** trusted relative to other workspaces. Workspace isolation is an
**in-app authorization problem**, not an infrastructure one.

The dominant risk is **workspace isolation / IDOR**: every resource
(project, task, comment, attachment, notification, audit entry,
real-time event) must be reachable only if the caller is an authorized
member of the workspace that owns it. This must be a structurally
enforced invariant, not a UI concern or convention.

Second-order risks:

- Real-time event leakage (WebSocket broadcasts bypassing REST authz
  unless deliberately gated — deferred to Phase 3, but the architecture
  anticipates it).
- Privilege escalation via role changes — permission changes must take
  effect immediately, with no stale cached permissions.
- Session security — no default credentials, first-admin bootstrap,
  session fixation resistance, audited revocation.
- Mass assignment — clients must not set `workspaceId`, `role`,
  `ownerId`, `id`, or `createdBy`; validation is allowlist-based per
  endpoint.
- File upload risks (deferred to Phase 4, but a storage abstraction is
  planned now).
- Concurrent updates / lost writes — optimistic concurrency via a
  `version` column, deferred to Phase 2 for tasks, but schema-aware now.
- Audit/activity hygiene — logs must never contain secrets or raw
  request bodies.

Self-hosting simplicity is a hard product constraint: clone -> env vars
-> `docker-compose up` -> create first admin. This biases every tech
decision toward few moving parts, one command to run, persistent
volumes, no cloud dependencies, and approachability for a solo/small OSS
team. This is resolved as a **well-structured modular monolith**,
explicitly rejecting microservices.

## 2. Technology selection

| Concern | Choice | Primary reason |
|---|---|---|
| Language | TypeScript (front+back) | Shared types, one contributor pool |
| Backend | Fastify | JSON-schema validation (anti-mass-assignment), built-in Pino structured logging with redaction, native TS, plugin/encapsulation model maps to modules |
| DB | PostgreSQL 16 | Relational integrity reinforces isolation (FKs mean task→project→workspace is structurally enforced) |
| ORM/migrations | Prisma (+ raw parameterized SQL for analytics later) | Best DX, declarative schema doubles as documentation, real migration workflow, Prisma Client Extensions can add defense-in-depth workspace filtering |
| Real-time (Phase 3) | Socket.IO (+ Redis adapter) | Rooms map to workspace/project = authz boundary; reconnection; fan-out |
| Cache/queue/ratelimit | Redis + BullMQ | Correct rate limits across restarts/processes, job queue for email, pub/sub |
| Frontend | React + Vite SPA (not Next.js) | Interactive authenticated dashboard; no SSR/SEO value behind login; simpler self-host deploy |
| Styling/theme | Tailwind CSS | Light/dark + responsive built in |
| Drag-drop (Phase 2) | @dnd-kit | Accessible Kanban |
| Validation/contracts | Zod (shared package) | One schema definition, drives anti-mass-assignment allowlisting, usable both backend and frontend |
| API | REST + OpenAPI (Swagger); WebSocket push-only in later phases | Documented, testable, single write path — all mutations via REST, so every mutation passes one authz+validation+persistence path |
| Auth | Server-side sessions in Postgres via secure httpOnly cookie (chosen over JWT) | Instant revocation is a hard requirement (permission changes must take effect immediately; logout-everywhere; audited session revocation) — JWTs can't be revoked before expiry without reintroducing server-side state anyway |
| Deploy | Docker Compose | One-command self-host; app + Postgres + Redis; named volumes for persistence; Kubernetes explicitly out of scope |

### Defensible overrides (not re-litigated, but noted as open decisions)

- Fastify vs NestJS — using Fastify.
- Prisma vs Drizzle — using Prisma.
- Whether `OWNER` is single-holder — multiple OWNERs are allowed, but the
  "last owner" cannot be demoted or removed.
- CSRF strategy — double-submit cookie token (chosen).
- Invitation acceptance — requires the accepting user's authenticated
  email to strictly match the invited email (chosen).

## 3. Full data model (all phases)

Every entity below is implemented as a real Prisma model today
(`apps/api/prisma/schema.prisma`) — the schema file's own header comment is
a leftover from Phase 1 and undersells how much has been added since; this
table reflects the actual current schema, not a future target. The "Notes"
column still cites the phase each entity was introduced in, purely as
historical provenance.

`Team`/`TeamMembership`, originally sketched here as a possible Phase 2+
addition, were never built as separate models — `ProjectMembership` (Phase
2) and `CategoryMembership` (Phase 9) turned out to cover the same
scoping need one level down from the workspace, so a standalone Team
concept was dropped rather than left half-implemented.

| Entity | Scope | Notes |
|---|---|---|
| User | Global | Email unique (case-insensitive), argon2id password hash, platform-admin flag |
| Session | Global | Opaque token, hashed at rest, idle + absolute expiry |
| Workspace | Tenant root | Owns everything below via `workspaceId` |
| Role | Workspace-scoped | OWNER / ADMIN / PROJECT_MANAGER / MEMBER / VIEWER / CLIENT |
| RolePermission | Workspace-scoped | Role -> permission string mapping |
| WorkspaceMembership | Workspace-scoped | **The isolation linchpin.** Unique `(workspaceId, userId)` |
| Invitation | Workspace-scoped | Token-based, hashed token, partial-unique pending per `(workspaceId, email)` |
| Project | Workspace-scoped | Phase 2 |
| ProjectMembership | Workspace-scoped | Phase 2 (needed for CLIENT project-level scoping) |
| TaskCategory | Project-scoped | Phase 9. Required sub-division inside a project; owns its own board. `CategoryVisibility` (`workspace`/`private`) mirrors `ProjectVisibility` one level down. New projects start with **zero** categories (deliberate; see docs/PHASES.md Phase 9) |
| CategoryMembership | Project-scoped (via category) | Phase 9. Mirrors `ProjectMembership` exactly, one level down |
| BoardColumn/Status | Category-scoped | Phase 2, re-scoped in Phase 9 from `projectId` to `categoryId` (each category now owns its own board; `projectId`/`workspaceId` stay denormalized alongside `categoryId`). Optional nullable `color` (hex string) added post-Phase-9 for a custom per-column accent, independent of the todo/in_progress/done `category` enum; falls back to the category-based default color when unset |
| Task | Category-scoped | `parentTaskId` for subtasks, `version` column for optimistic concurrency, `workspaceId`/`projectId` denormalized; Phase 2, re-scoped in Phase 9 to add a required `categoryId` (a task belongs to exactly one category). `completedAt` is the single source of truth for "done" (set automatically on a done-category column transition, or explicitly via the task-completion checkbox without moving the task's column) — analytics keys off this field directly, never the task's current column category |
| Label / TaskLabel | Project-scoped | Phase 2. Deliberately NOT category-scoped — kept separate from Categories (Phase 9): free-form, multi-select, per-task tags vs. a structural grouping |
| TaskAssignee | Task-scoped | Phase 2 |
| Milestone | Project-scoped | Phase 2. Deliberately NOT category-scoped (Phase 9) — milestones remain project-wide |
| Comment / Mention | Task-scoped | Phase 4 |
| Attachment | Task-scoped | Phase 4, via StorageProvider abstraction |
| Notification | User-scoped | Phase 4 |
| ActivityEvent | Project-scoped, optionally category-scoped | Normal project feed; Phase 5. `categoryId` (Phase 9) is nullable — set for task-level events, null for project-level ones (e.g. `milestone_completed`); the project-wide feed excludes events for private categories the caller can't see |
| AuditLogEntry | Workspace-scoped (nullable for instance-level events) | Separate, append-only, administrative/security events; **starts in Phase 1** |

Every workspace-owned entity carries a `workspaceId` column (denormalized
onto deep entities, e.g. `Task.workspaceId`) so every authz check and
query filter is a direct `WHERE workspaceId = ctx.workspaceId`, and
composite/foreign keys prevent cross-workspace linking at the database
level.

### Phase 1 entity-relationship summary

```
User 1───* Session
User 1───* WorkspaceMembership *───1 Workspace
Workspace 1───* Role 1───* RolePermission
Workspace 1───* Invitation *───1 Role
User 1───* Invitation (invitedBy)         [optional]
User 1───* Invitation (acceptedUser)      [optional]
Workspace 1───* AuditLogEntry             [workspaceId nullable]
User 1───* AuditLogEntry (actor)          [actorId nullable]
```

### Phase 9 entity-relationship extension — Categories

`Project -> Category -> Task` is a new required isolation tier inserted
between the existing `Project` and `BoardColumn`/`Task` layer, mirroring
`Workspace -> Project`'s own visibility/membership pattern one level down:

```
Workspace 1───* TaskCategory
Project 1───* TaskCategory                [required sub-division; 0 at project creation, never 0 again after the 1st]
TaskCategory 1───* CategoryMembership *───1 User
TaskCategory { visibility: workspace | private }   [mirrors ProjectVisibility]
TaskCategory 1───* BoardColumn                      [each category owns its own board]
TaskCategory 1───* Task                             [a task belongs to exactly ONE category]
BoardColumn  { projectId, categoryId }              [projectId denormalized alongside categoryId]
Task         { workspaceId, projectId, categoryId } [full parent chain denormalized, same convention as before]
ActivityEvent { categoryId: nullable }              [null for project-level events, e.g. milestone_completed]
```

Access rule (`requireCategoryAccess`, enforced immediately after
`requireProjectAccess` in the guard chain): `workspace`-visibility
categories are open to anyone who already has project access;
`private`-visibility categories require a `CategoryMembership` row or a
role ranked >= Project Manager; CLIENT-role users always require an
explicit `CategoryMembership` row regardless of visibility. Every denial
path is `404`, matching the same non-leaking invariant used at every
other layer in this system.

## 4. Security risk register and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | IDOR / cross-workspace access | Mandatory `requireMembership` guard loads the caller's `WorkspaceMembership` from the URL `workspaceId`; missing membership -> 404 (not 403, avoids existence leak); all queries filter `WHERE workspaceId = ctx.workspaceId`; deep entities denormalize `workspaceId`; DB composite FKs prevent cross-workspace linking. |
| 2 | Real-time event leakage (Phase 3) | Socket.IO handshake authenticated via the same session cookie; room joins authorized against live membership; server never broadcasts raw; membership changes force-update rooms. |
| 3 | Privilege escalation via role change | Permissions loaded fresh per request (never cached in the session/token); only `role.manage` holders can change roles; rank check prevents self-elevation; last-owner is protected; every change is audited. |
| 4 | Session fixation/hijacking | Opaque 256-bit random token, only SHA-256 hash stored server-side, `httpOnly`+`Secure`+`SameSite=Lax` cookie, new session id on login, server-side revocable (instant), idle + absolute expiry, CSRF double-submit token. |
| 5 | Mass assignment | Per-route Zod input schemas allowlist exactly the writable fields (`.strict()`); `workspaceId`/`role`/`ownerId`/`id`/`createdById`/`version` are never client-writable. |
| 6 | File upload abuse (Phase 4) | `StorageProvider` abstraction, server-generated storage keys, content-type/size checks, authorized serving endpoint. |
| 7 | Rate-limit bypass / brute force | `@fastify/rate-limit` backed by Redis, strict limits on login/registration/invite-accept, login failures audited. |
| 8 | Concurrent update lost writes (Phase 2 for tasks) | `version` column + conditional update + 409 Conflict. |
| 9 | Secrets in logs/audit | Pino redaction paths (`password`/`token`/`authorization`/`cookie`/`secret`); audit/activity metadata is allowlisted, never raw request bodies. |
| 10 | No default credentials / insecure bootstrap | First-run setup flow only writable when zero users exist, rechecked in a Serializable transaction, self-disables permanently after first admin is created, no seeded credentials anywhere. |
| 11 | Debug/info disclosure in prod | `NODE_ENV=production` disables stack traces in responses; structured error handler with safe error shapes + request id. |
| 12 | Injection | Prisma parameterizes all queries; Zod validates all inputs; React escapes output by default. |
| 13 | Privilege leak via error/existence | Unauthorized workspace access returns 404, not 403. |
| 14 | Category-level isolation bypass (Phase 9) | `requireCategoryAccess` enforces the same live, never-cached, 404-not-403 pattern as `requireProjectAccess`, one level down, on every category/column/task/comment/attachment route; every task/column/comment/attachment query is scoped by `categoryId`, not merely `projectId`, so a resource in category A is never reachable via category B's URL even within the same project; real-time task/column/comment/attachment events broadcast to the category's Socket.IO room only (never also the parent project's room), and `revalidateRoomsForUser` re-checks category-room membership on every permission-change sweep the same way it already does for project rooms; the project-wide activity feed and analytics endpoints both narrow their result sets to the caller's visible-category-id set via a single shared helper (`listVisibleCategoryIdsForUser`), so a private category's data can never leak through an adjacent, differently-scoped endpoint. |

## 5. Modular monolith module map (current)

The Phase 1 module set below has grown as later phases shipped; this is
the full current `apps/api/src/` layout, not just the Phase 1 subset:

```
apps/api/src/
  config/env.ts     Zod-validated environment configuration, fail-fast
  core/             prisma, redis, logger (Pino + redaction), errors, health
  auth/             password hashing, sessions, register/login/logout/me, first-admin setup
  rbac/             request context, guards (requireAuth/requireMembership/requirePermission/
                    requireProjectAccess/requireCategoryAccess), rank/last-owner/last-category rules
  workspaces/       workspace CRUD, membership listing/role changes, invitations
  audit/            append-only security audit log writer (allowlisted metadata)
  email/            email abstraction (dev console transport unless SMTP_URL is set)
  projects/         project CRUD; categories (Phase 9) CRUD + membership; board columns
                    (incl. custom color); tasks/subtasks (incl. the completion checkbox);
                    labels; milestones; task dependencies
  comments/         task comments + @mention parsing (Phase 4)
  attachments/      file attachments via the StorageProvider abstraction (Phase 4)
  notifications/    mention/assignment notifications (Phase 4)
  activity/         per-project/per-category activity feed (Phase 5)
  analytics/        analytics aggregation + rule-based health-status classification (Phase 6)
  realtime/         Socket.IO server, workspace/project/category room access rules (Phase 3, extended Phase 9)
  storage/          StorageProvider interface + local-disk implementation (Phase 4)
```

Each module is a Fastify plugin-shaped unit; encapsulation mirrors
Fastify's own plugin/context model, keeping the monolith modular without
introducing service boundaries or network hops.
