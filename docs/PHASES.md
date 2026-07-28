# ProjectHub Phase Roadmap

ProjectHub's full v1 scope is delivered incrementally across eight
phases. This document describes each phase's intent. Phase 1 is
implemented in this repository today; Phases 2-8 are planned and
described at a level sufficient to guide future work, without
prescribing implementation details that belong to their own planning
pass.

## Phase 1 — Foundation: Auth, Workspaces, RBAC scaffold (implemented)

**Goal:** a working, tested backend foundation that makes workspace
isolation and role-based access control non-negotiable from day one,
plus just enough frontend to exercise the flows end-to-end.

**Delivered:**

- Self-hosted authentication: registration, login, logout, `GET
  /api/auth/me`, session listing/revocation — all backed by opaque,
  server-side sessions (never JWTs) so permission/role changes and
  logout-everywhere take effect instantly.
- First-admin bootstrap flow (`/api/setup`) that only works while zero
  users exist, guarded by a Serializable transaction re-check, with no
  seeded/default credentials anywhere in the codebase.
- Multi-workspace membership: create workspace, list my workspaces, get
  workspace detail, update workspace settings — all gated by
  `requireMembership`, returning 404 (not 403) for non-members.
- RBAC scaffold: six default system roles (Owner, Administrator, Project
  Manager, Member, Viewer, Client) seeded transactionally at
  workspace-creation time, with a shared permission catalog and
  rank-based rules (cannot assign a role above your own rank; cannot
  demote/remove the last Owner).
- Real, end-to-end invitation token flow: create invitation (hashed
  token, expiring, single-use), public token preview, authenticated
  accept with strict invited-email matching, revoke.
- Append-only `AuditLogEntry` log for security-relevant events
  (login success/failure, setup completion, invite/role/member/settings
  changes, session revocation), with allowlisted, secret-free metadata.
- CSRF protection (double-submit cookie) on all authenticated
  state-changing routes; Redis-backed rate limiting, especially on
  login.
- Docker Compose stack (`api` + `db` + `redis`) with health checks and
  an `uploads` volume reserved for Phase 4.
- Minimal frontend (setup, login, workspace list/create, invite-accept)
  — just enough to click through the flows manually.

**Explicitly not built in Phase 1:** projects, tasks, subtasks, labels,
milestones, Kanban boards; real-time/Socket.IO; comments, mentions,
notifications, attachments; activity feed generation (only the security
audit log); analytics/health-status; search/filter/theming polish;
backup/restore; full production hardening docs.

## Phase 2 — Projects, Tasks, Subtasks, Kanban CRUD

Introduces `Project`, `ProjectMembership`, `BoardColumn`/`Status`,
`Task` (with `parentTaskId` for subtasks), `Label`/`TaskLabel`,
`TaskAssignee`, and `Milestone`. Extends the workspace-isolation test
suite built in Phase 1 down to tasks (every task query filters by the
denormalized `workspaceId`, and cross-project/cross-workspace access
returns 404 the same way cross-workspace access does today). Implements
full optimistic concurrency on `Task` via a `version` column: conditional
updates that lose the race return `409 Conflict` rather than silently
overwriting a concurrent edit. Kanban board CRUD (columns, ordering,
moving tasks between columns) and drag-and-drop groundwork (`@dnd-kit` on
the frontend) land here.

## Phase 3 — Real-time layer

Adds Socket.IO (with the Redis adapter for multi-process fan-out) as a
push-only real-time layer alongside the existing REST API — all writes
still go through REST so every mutation passes the single
authz+validation+persistence path established in Phase 1. The
WebSocket handshake is authenticated using the same session cookie as
the REST API; clients join rooms scoped to workspace/project, and room
membership is (re-)authorized against live `WorkspaceMembership` data,
not cached at connection time. A membership or role change forces an
immediate room membership update so a demoted/removed user stops
receiving events for a workspace they can no longer access, mirroring
the "permissions take effect immediately" guarantee from Phase 1.

## Phase 4 — Comments, mentions, notifications, attachments

Adds `Comment` and `Mention` (with @mention parsing and notification
fan-out), a `Notification` model and delivery (in-app, building on the
Phase 3 real-time layer), and `Attachment` file uploads via a
`StorageProvider` abstraction. The abstraction ships with a local-disk
implementation for self-hosted simplicity (using the `uploads` volume
already declared in Phase 1's `docker-compose.yml`) and is designed to
be S3-compatible-ready for a later swap without changing call sites.
Upload handling enforces content-type/size checks and server-generated
storage keys, and files are served only through an authorized endpoint
that re-checks workspace membership — attachments never become directly
and publicly linkable.

## Phase 5 — Activity feed + audit log expansion

The security-focused `AuditLogEntry` log from Phase 1 continues to
capture administrative/security events. This phase adds the
user-facing **activity feed** (`ActivityEvent`) for ordinary project
activity (task created/moved/completed, comment posted, member added to
a project, etc.), scoped and filtered per project/workspace with the
same isolation guarantees as every other resource.

## Phase 6 — Analytics + rule-based explainable health status

Adds an analytics dashboard (throughput, completion trends, workload
distribution) and a rule-based, explainable project health-status engine
that classifies projects as On Track / At Risk / Delayed with
human-readable reasons (e.g. "3 tasks overdue", "no activity in 10
days") rather than an opaque score — consistent with the product's
"explainable" requirement. Analytics queries use raw parameterized SQL
where Prisma's query builder isn't a good fit, per the Phase 0
technology selection.

## Phase 7 — Search/filter, light/dark mode, responsive polish

Adds workspace-wide search and filtering across projects/tasks, full
light/dark theming (building on the brand palette established in Phase
1's minimal frontend), and responsive layout polish across breakpoints.
This phase is primarily frontend-focused and does not introduce new
backend authorization surface.

## Phase 8 — Hardening, docs, backup/restore, production readiness

Closes out v1 with full production hardening documentation, a completed
`SECURITY.md` and `CONTRIBUTING.md` (both stubbed in Phase 1), database
backup/restore scripts/documentation for the self-hosted Postgres
volume, expanded production configuration guidance, and an end-to-end
self-host smoke test that walks through `docker-compose up` on a clean
machine to first-admin setup to a fully working workspace.
