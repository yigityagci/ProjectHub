# ProjectHub Phase Roadmap

ProjectHub's full v1 scope is delivered incrementally across eight
phases. This document describes each phase's intent. Phases 1 and 2 are
implemented in this repository today; Phases 3-8 are planned and
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

## Phase 2 — Projects, Tasks, Subtasks, Kanban CRUD (implemented)

**Goal:** full project/task/Kanban CRUD on top of the Phase 1
workspace/RBAC foundation, with project-level access control layered on
top of workspace membership, optimistic concurrency on tasks, and a
working drag-and-drop board in the frontend.

**Delivered:**

- `Project`, `ProjectMembership`, `BoardColumn`, `Task` (with
  `parentTaskId` for one-level-deep subtasks), `Label`/`TaskLabel`,
  `TaskAssignee`, `Milestone`, and `TaskDependency` models — all
  workspace-scoped with a denormalized `workspaceId` on every table,
  cascading from `Workspace`, matching Phase 1's schema conventions.
- A second access-control layer (`requireProjectAccess`) on top of
  Phase 1's `requireMembership`: workspace-visible projects are open to
  any active workspace member; private projects require a
  `ProjectMembership` row or a role ranked at or above Project Manager;
  Client-role users always require an explicit `ProjectMembership` row
  regardless of visibility. Every denial path returns `404`, never
  `403`, so unauthorized callers can't distinguish "doesn't exist" from
  "exists but you can't see it" — the same invariant Phase 1 established
  for workspaces.
- A new permission catalog slice (`project.archive`,
  `project.members.manage`, `board.manage`, `task.create`, `task.edit`,
  `milestone.manage`, `label.manage`, `dependency.manage`) layered onto
  the existing six system roles: Admin and Project Manager get full
  project/board/task management (Project Manager still cannot delete a
  project — that stays Admin/Owner only); Member can create and edit
  tasks but not delete them or manage boards/labels/milestones/
  dependencies; Viewer and Client remain strictly read-only.
- Full REST CRUD for projects, project members, board columns (with
  fractional-position ordering and transactional reorder/rebalance),
  tasks, task assignees, task labels, milestones, and task dependencies.
- Mandatory optimistic concurrency on every task update/move via a
  `version` column: the client-supplied version is used only as a WHERE
  precondition (never persisted as a plain write), and a lost race
  returns `409 VERSION_CONFLICT` with the current server-side task
  attached, instead of silently overwriting a concurrent edit.
- Server-side cycle prevention on task dependencies (DFS over existing
  edges before inserting a new one, self-dependency rejected) and
  strict one-level-only subtask nesting validation.
- Kanban board frontend: a projects list page, a drag-and-drop board
  (`@dnd-kit`) that calls the real move-task API on drop and reverts
  with a toast on failure, and a task detail modal (title, description,
  priority, dates, assignees, labels, subtasks, dependencies) with a
  conflict banner + reload-and-discard flow when a `409` is received.
- Extended the workspace-isolation test suite from Phase 1 down to
  every new resource type: cross-workspace and cross-project access
  attempts return `404` the same way cross-workspace access does for
  Phase 1 resources.

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
