# ProjectHub Phase Roadmap

ProjectHub's full v1 scope is delivered incrementally across eight
phases. This document describes each phase's intent. Phases 1-4 are
implemented in this repository today; Phases 5-8 are planned and
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

## Phase 3 — Real-time layer (implemented)

**Goal:** a push-only Socket.IO layer alongside the existing REST API,
so that every mutation still passes through the single
authz+validation+persistence path established in Phase 1 — Socket.IO
never accepts writes, it only broadcasts after a REST mutation has
already been persisted.

**Delivered:**

- Socket.IO server (with `@socket.io/redis-adapter` on the existing
  Redis instance, for multi-process fan-out) attached directly to the
  Fastify server's underlying HTTP server.
- WebSocket handshake authentication reuses the exact same
  session-cookie lookup as the REST API (`auth/session.ts#resolveSession`)
  — no parallel auth mechanism. The raw `cookie` header is parsed by
  hand in `realtime/realtime.ts` since the Socket.IO handshake doesn't
  go through Fastify's own cookie-parsing plugin.
- Clients request to join `workspace:{id}` and `project:{id}` rooms
  (plus an automatic `user:{id}` room on connect, used for Phase 4
  notifications); every join is authorized against **live**
  `WorkspaceMembership`/`ProjectMembership` data at request time
  (`realtime/access.ts`), mirroring `requireMembership`/
  `requireProjectAccess`'s rules exactly (including the CLIENT-role and
  private-project rules).
- Immediate eviction on permission loss: workspace member removal, role
  changes, and project member removal all call
  `revalidateRoomsForUser`, which re-checks every room each of that
  user's currently-connected sockets is in and force-leaves any it can
  no longer access — the same "permissions take effect instantly"
  guarantee Phase 1 established for sessions, now extended to real-time
  rooms. Covered by a dedicated, non-negotiable test
  (`test/realtime-eviction.test.ts`) using a real Socket.IO client
  against a real TCP listener (the only test file in this suite that
  doesn't rely on Fastify's `inject()`).
- Broadcasts hooked into the Phase 2 mutation paths after successful
  persistence: task created/updated/moved/deleted, project membership
  changed, board column created/updated/reordered/deleted — plus the
  new Phase 4 events (comment created/deleted, attachment
  created/deleted, notification created).
- Frontend Socket.IO client (`apps/web/src/lib/socket.ts`) connects once
  a session exists, joins the current workspace/project rooms, and
  live-updates the Kanban board and task detail modal as other users'
  mutations arrive.

**Scaffolded, not exhaustive:** no reconnection-specific room re-join
retry/backoff policy beyond the client library's defaults; no explicit
rate-limiting of socket event volume (mirrors the REST API's global
rate limit only).

## Phase 4 — Comments, mentions, notifications, attachments (implemented)

**Goal:** task-level collaboration primitives (comments, @mentions,
notifications, file attachments) on top of the Phase 1-3 foundation,
with the same workspace-isolation and permission-enforcement guarantees
as every other resource.

**Delivered:**

- `Comment`, `Mention`, `Notification`, and `Attachment` models — all
  workspace-scoped with a denormalized `workspaceId`, cascading from
  `Workspace`/`Task`/`Comment`, matching Phase 1/2's schema
  conventions. Real Prisma migration
  (`prisma/migrations/20260728151956_phase4_comments_mentions_notifications_attachments`).
- **Mention parsing convention (judgment call):** the frontend's
  mention-autocomplete inserts opaque `@[userId]` tokens into the raw
  comment body (never free-text `@displayName`/`@email` matching, which
  is ambiguous with duplicate names and requires guessing intent
  server-side). The server re-parses these tokens at comment-creation
  time and only honors ones that resolve to an active workspace member;
  the frontend renders tokens back to friendly `@DisplayName` text for
  display only (`lib/mentions.ts`).
- A deliberately small `NotificationType` catalog (`mention`,
  `task_assigned`, `comment_reply`) — `comment_reply` is modeled but not
  yet triggered by any flow in this phase (no threaded replies yet).
  Notifications are created after the triggering mutation is persisted
  (comment created → notification per mentioned user; task assignee
  added → notification for the assignee), pushed live to the
  recipient's own `user:{id}` real-time room, and listable/markable via
  `GET /api/notifications`, `POST /api/notifications/:id/read`, and
  `POST /api/notifications/read-all` — all scoped strictly to the
  caller's own notifications (404, not 403, for someone else's
  notification id, consistent with this codebase's existing
  IDOR-prevention convention).
- Comment/attachment creation reuses the existing `task.edit`
  permission rather than introducing a new `comment.create` permission
  (a judgment call — the same roles that can edit a task's content can
  comment on/attach files to it; VIEWER/CLIENT remain strictly
  read-only, unchanged from Phase 2). Comment/attachment **deletion**
  is an author-or-Admin/Owner rule enforced in the service layer, not a
  permission gate.
- A `StorageProvider` abstraction (`storage/storage-provider.ts`) with a
  local-disk implementation (`storage/local-disk-provider.ts`) backed by
  the `uploads` volume already declared in Phase 1's
  `docker-compose.yml`. Storage keys are always server-generated opaque
  UUIDs, never derived from the client-supplied filename, so path
  traversal isn't possible even in principle; call sites never touch
  the filesystem directly, so an S3-compatible implementation could be
  swapped in later without changing any call site.
- Upload handling enforces a content-type allowlist
  (`packages/shared/src/dto/attachment.ts`) and a configurable size
  limit (`UPLOAD_MAX_SIZE_BYTES`, default 25MB) via `@fastify/multipart`.
  Attachments are served only through an authorized proxy download
  endpoint that re-runs the full `requireAuth` +
  `requireMembership` + `requireProjectAccess` chain on every request —
  there is no static file serving of the uploads directory, so
  attachments never become directly, publicly linkable.
- Full REST CRUD under
  `/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/{comments,attachments}`,
  following Phase 2's route/guard conventions exactly, with every
  cross-workspace/cross-project access attempt returning `404`.
- Frontend: a comments section (list + add form + mention autocomplete
  + author/timestamp + delete gated to author/Admin/Owner) and an
  attachments section (upload/list/download/delete) in
  `TaskDetailModal.tsx`, and a minimal notification bell + dropdown
  (unread count, mark-as-read/mark-all-read) in the app shell
  (`components/NotificationBell.tsx`, used from `WorkspacesPage.tsx` and
  `KanbanBoardPage.tsx`).

**Scaffolded, not exhaustive:** local-disk storage only (no S3
implementation yet, by design — Phase 4 explicitly defers it); no
comment editing (create/delete only); no attachment thumbnails/previews;
`comment_reply` notifications aren't generated yet (no reply-threading
model in this phase).

## Phase 5 — Activity feed + audit log expansion (implemented)

**Goal:** a separate, user-facing **activity feed** for ordinary project
events, parallel to (and never touching) the Phase 1 security/audit log.

**Delivered:**

- `ActivityEvent` model — workspace-scoped with a denormalized
  `workspaceId`, cascading from `Workspace`/`Project`, `actorId` FK to
  `User` — matching Phase 1/2/4's schema conventions. Real Prisma
  migration
  (`prisma/migrations/20260728155246_phase5_activity_events_phase6_task_completed_at`,
  combined with the Phase 6 `Task.completedAt` column since both landed in
  the same pass).
- A deliberately small `ActivityEventType` catalog: `task_created`,
  `task_moved`, `task_assigned`, `comment_added`, `milestone_completed`.
  This is explicitly not exhaustive — member-added-to-project, label
  changes, and similar events are not covered in this v1 pass.
- Every event's `payload` denormalizes human-readable context (task
  title, from/to column names, actor display name, assignee display name,
  milestone name) at creation time, so the feed never needs to re-join to
  Task/BoardColumn/User at render time — those rows may change or be
  deleted later, but the feed entry stays accurate to what happened.
- Activity-event creation is hooked directly into the existing Phase 2/4
  mutation services, immediately after (and in the task-create/
  comment-add/milestone-complete cases, in the same `$transaction` as) the
  primary persistence — never before it, and the real-time broadcast only
  fires after the write (and its transaction, if any) has actually
  committed, so a rolled-back mutation can never produce a phantom live
  event.
- `GET /api/workspaces/:workspaceId/projects/:projectId/activity`
  (cursor-paginated, most-recent-first), gated by the same
  `requireMembership` + `requireProjectAccess` read-access rules as
  everything else in the project — Viewer/Client included, since this is
  read-only. Cross-workspace/cross-project access returns 404 like every
  other resource.
- A new `activity.created` real-time event broadcast to the project's
  existing Socket.IO room.
- Frontend: an "Activity" tab on the Kanban board page
  (`KanbanBoardPage.tsx` renders the new `components/ActivityFeed.tsx`)
  showing a simple reverse-chronological list ("Alice created task
  ...", "Bob moved ... from To Do to Done", ...), live-updating via
  `activity.created`.

## Phase 6 — Analytics + rule-based explainable health status (implemented)

**Goal:** real operational metrics computed from actual task/dependency/
milestone data, plus a deterministic, rule-based (not AI-based) project
health-status classification with a human-readable, data-backed
explanation.

**Delivered:**

- `Task.completedAt` column, set the moment a task's column transitions
  into a `done`-category column (in `moveTask`) and cleared if it's moved
  back out — the single source of truth every completion-time metric
  depends on (not `updatedAt`, which changes on unrelated edits too).
- `GET /api/workspaces/:workspaceId/projects/:projectId/analytics`, gated
  by `requireMembership` + `requireProjectAccess` + the existing
  `analytics.view` permission (already granted to
  OWNER/ADMIN/PROJECT_MANAGER since Phase 1/2 — confirmed unchanged, no
  new roles were granted access). Returns: total/completed/overdue/blocked
  task counts and completion percentage; tasks completed per day over the
  last 30 days; open-task workload per assignee; tasks grouped by status
  (board column) and by priority; average task completion time
  (`completedAt - createdAt`, mean over completed tasks); per-milestone
  task totals/completed/percentage; overall project progress percentage;
  and the most recent Phase 5 activity events.
- The 30-day completed-over-time series uses raw parameterized SQL
  (`$queryRaw` with a tagged template, `generate_series` + a date-truncated
  join) since a zero-filled daily bucket series is a clearly better fit for
  SQL than reconstructing the calendar in JS; every other metric uses a
  single `Task.findMany` pass aggregated in JS, which is simpler and
  equally clear for these small, per-project collections — a deliberate
  per-query judgment call rather than forcing raw SQL everywhere.
- **Rule-based health-status engine**
  (`apps/api/src/analytics/health-status.ts`), isolated from the rest of
  analytics so its thresholds are easy to find and adjust:
  classifies each project as `on_track` / `at_risk` / `delayed` from fixed,
  named thresholds — `delayed` if more than 40% of open tasks are overdue,
  OR a high/urgent-priority task has been blocked (via an incomplete
  `TaskDependency`) for more than 7 days, OR the project's `targetDate` has
  passed with incomplete tasks remaining; `at_risk` (checked only if not
  already `delayed`) if more than 20% of open tasks are overdue, OR any
  URGENT-priority task is currently blocked (or 2+ high-priority tasks are
  blocked), OR milestone completion trails the project's elapsed
  start-to-target-date timeline by more than 20 percentage points;
  otherwise `on_track`. Every response includes a human-readable
  `explanation` string built dynamically from the exact numbers that
  triggered the classification (e.g. "This project is marked At Risk
  because 3 of 12 open tasks are overdue (25%) and an urgent-priority task
  is currently blocked."), never a canned template. These thresholds are a
  defensible v1 default, not tuned against real usage data — there isn't
  any yet.
- Frontend: `AnalyticsPage.tsx`, reachable via an "Analytics" link from the
  Kanban board's subnav, showing the health-status badge and explanation
  prominently at the top, followed by plain stat cards, simple bar rows
  (workload/status/priority/milestone progress), and a small sparkline for
  the 30-day completion trend — no charting library, matching the existing
  minimal `ph-*` CSS approach.

**Scaffolded, not exhaustive:** the health-status thresholds are a
reasonable, documented v1 default meant to be revisited once there's real
usage data to tune against, not a claim of optimality; "blocked since" is
approximated from the blocking `TaskDependency` edge's `createdAt` (no
separate "became blocked at" timestamp exists); milestone-pace elapsed-time
is measured against the project's own `startDate`/`targetDate`, not each
milestone's individual target date.

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
