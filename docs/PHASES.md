# ProjectHub Phase Roadmap

ProjectHub's v1 scope was delivered incrementally across nine numbered
phases (Phase 8 closed out the original eight-phase plan; Phase 9 was
added afterward to introduce Categories). This document describes each
phase's intent. **All nine phases are implemented in this repository.**
Each phase's section below describes what it delivered and, honestly,
what remains scaffolding-tier rather than exhaustively hardened - see each
phase's own "Scaffolded, not exhaustive" note. A closing section after
Phase 9 covers feature work that shipped afterward outside the numbered-
phase structure (Tailwind/responsive fixes, the visual redesign, custom
column colors, and the task-completion checkbox).

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

## Phase 7 — Search/filter, light/dark mode, responsive polish (implemented)

**Goal:** workspace-wide search and filtering across projects/tasks, full
light/dark theming (building on the brand palette established in Phase
1's minimal frontend), and responsive layout polish across breakpoints -
primarily frontend-focused, deliberately introducing no new backend
authorization surface (every filter composes with, never replaces, the
existing `requireMembership`/`requireProjectAccess` scoping).

**Delivered:**

- `GET /api/workspaces/:workspaceId/projects/:projectId/tasks` extended
  with `q` (substring match over title/description), `columnId`,
  `priority`, `assigneeId`, `labelId`, `overdue` (boolean: past `dueDate`
  and no `completedAt`), `parentTaskId`, and `hasSubtasks` query params
  (`packages/shared/src/dto/task.ts#taskListQuerySchema`, `.strict()` so
  an unrecognized/crafted query field is rejected outright, not silently
  ignored). Every filter is `AND`-composed in the Prisma `WHERE` builder
  on top of the `projectId` that guard chain already resolved from the
  URL - a filter can never reach another project's or workspace's tasks,
  even when two different projects have identically-titled tasks (covered
  by a dedicated isolation test).
- `GET /api/workspaces/:workspaceId/projects` extended the same way with
  `q` (name/description substring), `status`, and `archived`, `AND`
  -composed on top of the exact same access-visibility rules Phase 2
  established (CLIENT-role membership-only visibility, private-project
  rank/membership rules) - filtering never widens what a caller could
  already see.
- Both are plain substring (`contains`, case-insensitive) `WHERE` filters,
  not a full-text search index - a deliberate v1 scaffolding choice,
  adequate for per-project/per-workspace collections at this scale.
- Frontend: a debounced search box + status/archived dropdowns on
  `ProjectsPage.tsx`, calling the extended API (workspaces can have many
  projects, so this filters server-side); a search box + priority/
  assignee/label dropdowns + an "overdue only" toggle on
  `KanbanBoardPage.tsx`, filtering the already-fully-fetched board
  client-side (a project's full task set is small enough that this is
  simpler and equally correct, per this phase's own scope note above) -
  both share a `.ph-filter-bar` styling convention.
- A full light/dark theme system
  (`apps/web/src/lib/theme.ts`, `components/ThemeToggle.tsx`): every color
  used anywhere in `styles.css` or in a component's inline styles routes
  through a CSS custom property, with a dark variant of the full palette
  (not a `filter: invert()` hack) covering every page and component built
  in Phases 1-6 (Kanban board, task modal, notifications, activity feed,
  analytics stat cards/bars/health banner, auth pages). Defaults to
  `prefers-color-scheme` with no stored preference; an explicit toggle
  choice (next to the notification bell/logout button in the app shell)
  is persisted in `localStorage` and forces the chosen theme via
  `<html data-theme="...">` regardless of system preference.
- A responsive-polish pass over every page from Phases 1-6, not just new
  Phase 7 surfaces: topbar wrapping instead of overflow at narrow widths,
  a clamped/scroll-safe notification dropdown, a narrower Kanban column
  basis on very small screens, a 2-column stat grid and viewport-clamped
  toast on small screens, and confirmation that the Phase 2 board
  horizontal-scroll and task-modal single-column stacking still hold.

**Scaffolded, not exhaustive:** substring search only (no full-text
index/ranking); the Kanban board's search/filter is client-side against
an already-fetched board rather than a server round-trip (a deliberate,
documented simplification for a single project's task set, not a
limitation of the underlying API, which supports full server-side
filtering for exactly this reason); no saved/named filter presets.

## Phase 8 — Hardening, docs, backup/restore, production readiness (implemented)

**Goal:** everything that makes the "simple self-hosting" promise
actually true end-to-end for a stranger cloning this repository for the
first time - production configuration guidance, backup/restore, and
finished (not stubbed) policy documents.

**Delivered:**

- `SECURITY.md` fleshed out: a supported-versions statement appropriate
  for a pre-1.0 project, a private-reporting process (GitHub Security
  Advisory preferred, placeholder email alternative), an explicit
  acknowledgment/triage/disclosure-timeline process, and an explicit
  in-scope/out-of-scope list grounded in this project's actual threat
  model (workspace isolation, RBAC, real-time room authorization, upload
  handling, invitation tokens, rate limiting, audit logging, mass
  assignment).
- `CONTRIBUTING.md` fleshed out: local dev setup (pointing at README's
  quick-start and local-dev sections), repository/module layout, the
  project's non-negotiable security conventions (workspace isolation,
  `.strict()` input validation, 404-not-403, filters must compose with
  not replace scoping) restated as explicit contributor expectations,
  test-running instructions, and PR conventions. A new
  `CODE_OF_CONDUCT.md` (standard Contributor Covenant v2.1, genuinely
  generic - no real names) is referenced from it.
- **Backup/restore:** `scripts/backup.sh` and `scripts/restore.sh` - real,
  runnable bash scripts (not just documented command sequences) that
  `pg_dump`/restore the Postgres database and `docker cp`/tar the
  `uploads` volume out of (and back into) the running `api` container.
  Documented end-to-end, with exact commands and a "how do I know the
  backup/restore actually worked" verification checklist, in the new
  `docs/BACKUP_AND_RESTORE.md`.
- **Production configuration guidance:** a new `docs/PRODUCTION.md`
  covering every environment variable that matters for a real deployment
  (cross-checked against `apps/api/src/config/env.ts` - confirmed
  `.env.example` already covered every variable introduced through Phase
  6, including the Phase 4 upload-size/directory variables; no gaps
  found), concrete nginx **and** Caddy reverse-proxy example configs with
  correct WebSocket `Upgrade`/`Connection` header forwarding for the
  Socket.IO real-time layer (explicitly called out as the single most
  common real-world self-hosting failure point for this stack),
  HTTPS/`COOKIE_SECURE`/`CORS_ORIGIN` guidance, and a troubleshooting
  section (DB connection refused, migrations not applied, WebSocket
  upgrade failing behind a misconfigured proxy, upload failures from a
  full disk or misconfigured volume).
- **End-to-end self-host smoke test:** a precise, step-by-step manual QA
  checklist in `README.md` walking clone -> `.env` configuration ->
  `docker-compose up -d` -> first-admin setup -> workspace creation ->
  member invitation -> project/task/board creation -> live real-time
  updates across two sessions -> comments/mentions/notifications ->
  attachments -> activity feed -> analytics -> search/filter -> theme
  toggle -> taking a backup. Docker has not been available in this
  development environment in any phase, so this checklist has **not**
  been executed against a real Docker Engine here - stated plainly rather
  than implied otherwise - but every step maps to a flow already covered
  by the automated integration test suite.
- **Final consistency pass:** confirmed `LICENSE` and `NOTICE` are
  untouched and correct since Phase 1; rewrote the root `README.md`'s
  feature list and quick-start to accurately reflect everything built
  through Phase 7 (it previously only described Phase 1); confirmed
  `docker-compose.yml` and `.env.example` are in sync with every service/
  env var introduced across all phases (Redis needed no additional
  Socket.IO-specific configuration beyond the `REDIS_URL` it already had;
  the `uploads` volume and its mount path were already correctly declared
  in Phase 4).

**Scaffolded, not exhaustive:** the backup/restore scripts are functional
and documented, but are a single-node, full-dump strategy (no
point-in-time recovery, no offsite replication, no backup-file
encryption) and have not been disaster-tested against every possible
failure mode (mid-write crash, corrupted volume, cross-major-version
Postgres upgrade); the security-advisory/contact-email addresses in
`SECURITY.md`/`CODE_OF_CONDUCT.md` are placeholders that need to be
replaced with a real monitored inbox before an actual public 1.0 release;
the self-host smoke test is a documented manual checklist, not an
automated end-to-end (browser-driven) test suite.

## Phase 9 — Categories: a required Project -> Category -> Task isolation tier (implemented)

**Goal:** introduce "Categories" as a new, required sub-division inside
each Project — its own Kanban board, its own access-control layer,
mirroring the existing `Project`/`ProjectVisibility`/`ProjectMembership`
pattern exactly one level down — without disturbing the separate,
deliberately-unrelated Labels feature.

**This deliberately changes Phase 2's original data model, and that is
intentional, not an oversight.** Phase 2 gave every `Project` its own
`BoardColumn`s directly (3 auto-seeded defaults at project-creation time)
and every `Task` a `projectId`. Phase 9 inserts a new `TaskCategory` layer
between `Project` and `BoardColumn`/`Task`: a project's board columns and
tasks now belong to one of the project's categories, not to the project
directly. `BoardColumn`/`Task` still denormalize `projectId` (and
`workspaceId`) alongside their new `categoryId`, consistent with this
codebase's established "denormalize the full parent chain" convention —
nothing about that convention changed, only where the "leaf" scope sits.

**Product decision, stated plainly: a brand-new project intentionally
starts with ZERO categories, and this transient zero-category state is a
deliberate two-step creation UX (Option A), not an oversight or a bug.**
The project-creation form stays exactly as simple as it was in Phase 2
(name + visibility only — no category field). Immediately after a
project is created, the frontend forces the caller through a mandatory
"create your first category" step (no skip/cancel affordance) before any
board can be reached. The backend allows `POST .../projects` to succeed
with zero categories precisely so this two-step flow works; it is only
the *deletion* side that is protected as a standing invariant (see below)
— a project that has already reached >= 1 category can never be reduced
back to 0.

**Delivered:**

- New models `TaskCategory` (`@@map("task_categories")`) and
  `CategoryMembership` (`@@map("category_memberships")`), and a new
  `CategoryVisibility` enum (`workspace` / `private`) — deliberately named
  to avoid any confusion with the pre-existing `ColumnCategory` enum
  (`BoardColumn`'s todo/in_progress/done classification), which is
  unrelated. `TaskCategory` denormalizes `workspaceId`+`projectId`;
  `CategoryMembership` denormalizes `workspaceId`; both mirror
  `Project`/`ProjectMembership`'s shape field-for-field.
- `BoardColumn` and `Task` both gained a required `categoryId` FK
  alongside their existing `projectId`/`workspaceId`. `BoardColumn`'s
  unique constraint moved from `(projectId, name)` to `(categoryId,
  name)` — column names are now unique within a category's own board,
  not project-wide, since a project can have multiple categories each
  with independent "To Do"/"In Progress"/"Done" columns.
  `ActivityEvent` gained an optional `categoryId` (null for project-level
  events with no category in scope, e.g. `milestone_completed`, since
  milestones remain project-scoped and unaffected by this feature).
- **Migration:** this repository already has real, previously committed
  Prisma migration history (`apps/api/prisma/migrations/`, going back to
  Phase 1) — there was no "migrations were never generated" situation to
  work around. This is pre-production software with no real deployed data
  to preserve, so the schema change was applied as a single ordinary
  migration, `20260729120000_add_task_categories`: new `TaskCategory`/
  `CategoryMembership` tables + `CategoryVisibility` enum, and a required
  (`NOT NULL` from the start) `categoryId` FK on `board_columns`/`tasks`
  (plus an optional `categoryId` on `activity_events`, since project-level
  events like `milestone_completed` never have a category in scope), with
  `board_columns`' unique constraint on `(categoryId, name)` from the
  start. No nullable-then-required two-step sequencing and no backfill
  script were needed or used.
- **Guard chain:** a new `requireCategoryAccess` guard
  (`apps/api/src/rbac/guards.ts`), inserted immediately after
  `requireProjectAccess` and before any `requirePermission(...)` check, on
  every category-scoped route. Mirrors `requireProjectAccess` exactly:
  `workspace`-visible categories are open to anyone who already has
  project access; `private` categories require a `CategoryMembership` row
  or a role ranked >= Project Manager; **CLIENT always requires an
  explicit `CategoryMembership` row regardless of visibility** (this was
  a deliberate consistency decision — CLIENT already has this
  "always requires explicit membership" rule for projects, and Categories
  extends it one level down rather than inventing a different rule).
  Every denial path is `404`, never `403`, matching every other resource
  in this codebase.
- A new `assertNotLastCategory` helper
  (`apps/api/src/rbac/authorize.ts`), mirroring `assertNotLastOwner`'s
  exact shape/doc-comment style and race-avoidance requirement (checked
  live, in the same request as the delete): a project can never be
  reduced to zero categories via deletion. Category deletion additionally
  requires the category to have no tasks left in any of its columns
  (mirrors `columns.service.ts#deleteColumn`'s existing task-count check
  one level up) — both checks return `409 Conflict` with a clear message.
- New permission `category.manage`, appended to the permission catalog
  and granted to Owner (via the existing "Owner gets everything"
  all-permissions rule)/Admin/Project Manager only — Member/Viewer/Client
  never get it, matching `board.manage`'s existing grant shape.
- Routes restructured: the Phase 2 column/task routes moved from
  `.../projects/:projectId/columns|tasks...` to
  `.../projects/:projectId/categories/:categoryId/columns|tasks...`
  (`requireCategoryAccess` added to every preHandler chain; every service
  call re-scoped to `categoryId`, not just `projectId`, so a task from
  category A can never be reached via category B's URL even within the
  same project). Comments/attachments (Phase 4) — being task
  sub-resources — moved the same way, for the same reason. New category
  CRUD + membership routes under `.../projects/:projectId/categories`,
  including a default-column-seeding step (moved out of `createProject`,
  which no longer creates any `BoardColumn`s directly, and into category
  creation instead — this is the "no default categories, ever" rule in
  code: the 3 default columns are still seeded, just one level down, only
  once a human explicitly names a category).
- **Real-time:** a new `category:{id}` Socket.IO room
  (`apps/api/src/realtime/realtime.ts`), joined/left the same way
  `project:{id}` rooms are. `hasCategoryAccess`
  (`apps/api/src/realtime/access.ts`) mirrors `hasProjectAccess` exactly
  (including the CLIENT-always-requires-membership rule) and is used both
  for room-join authorization and inside `revalidateRoomsForUser`'s
  existing re-check-every-room loop, so a category membership/visibility
  change forces immediate eviction from a category room the user can no
  longer access — exactly like project rooms today. Task/column mutation
  events (`task.created`/`task.updated`/`task.moved`/`task.deleted`/
  `board.column.changed`) and task-scoped Phase 4 events
  (`comment.created`/`comment.deleted`/`attachment.created`/
  `attachment.deleted`) now broadcast to the category's room ONLY, not
  also the project's room — a user who can see a project overall but not
  one of its specific private categories must never receive that
  category's live events. Category-scoped `activity.created` events
  (anything with a non-null `categoryId`) follow the same rule; only
  project-level events (`categoryId` null) still broadcast to the
  project's room.
- **Activity feed (Phase 5) visibility fix:**
  `listActivityEvents` now optionally takes the caller's identity and
  narrows the feed to events whose `categoryId` is either `null`
  (project-level) or in the caller's visible-category-id set — computed
  by a new shared helper, `listVisibleCategoryIdsForUser`
  (`apps/api/src/projects/categories.service.ts`), reused (not
  reimplemented) by category listing, activity filtering, and analytics
  filtering below.
- **Analytics (Phase 6) visibility fix:** `getProjectAnalytics` stays
  project-wide (aggregating across every category the caller can see),
  but its task query — and the raw-SQL "completed over time" query — are
  both narrowed to only tasks whose `categoryId` is in the same
  visible-category-id set, so a caller without access to a private
  category never sees its tasks reflected in totals, workload, status,
  priority, completion-time, or health-status numbers.
  `recentActivity` automatically inherits the same filtering by reusing
  the same fixed `listActivityEvents`.
- **Search/filter (Phase 7):** no additional change needed beyond the
  route move itself — `taskListQuerySchema` filters already compose
  (`AND`) on top of whatever scope the route enforces, and that scope is
  now `categoryId` instead of `projectId`, the same way it always
  composed on top of `projectId` before.
- **Frontend flow:** project creation stays exactly as simple as before;
  on success the app now forces navigation into a mandatory "create your
  first category" step (`NewCategoryPage.tsx`, no skip/cancel), which
  creates the category and navigates directly into its board. Each
  project card now links to a new category picker (`CategoriesPage.tsx`)
  instead of a board directly — it lists categories the caller can see
  (private-category badge, never leaking a private category's existence
  to a non-member, mirroring how the project list never leaks private
  projects), with a distinct empty-state message depending on whether the
  caller could tell the difference safely: a rank-elevated caller (who is
  guaranteed visibility into every category regardless of privacy, same
  rule as `requireCategoryAccess`) sees "no categories yet — create the
  first one" with a working CTA, because for them an empty list
  unambiguously means zero categories exist; a non-privileged caller
  (who has no create permission anyway, and for whom an empty list could
  mean either "zero exist" or "some exist but aren't visible to me") sees
  a generic, non-leaking "you don't have access to any categories here"
  message with no action offered. `KanbanBoardPage.tsx` is now
  category-scoped (`:categoryId` route param, category-scoped
  endpoints, breadcrumb extended to Workspace / Project / Category /
  Board, a "Category settings" panel for rename/visibility/member
  management mirroring the existing inline column-management pattern's
  tone). Categories are deliberately styled as structural/navigational
  list/card items (new `.ph-category-list`/`.ph-category-card` CSS,
  mirroring the project-card list) — never as small colored tags, keeping
  them visually and conceptually distinct from Labels.
- Extensive test coverage: every existing test that created tasks/columns
  directly under a project was updated to create a category first
  (`test/helpers.ts#createCategoryAs`); a new `test/categories.test.ts`
  covers CRUD, the last-category and non-empty-category deletion
  invariants, the zero-category-at-creation-time success path, category
  membership immediacy, and `category.manage` role-gating;
  `test/project-access-isolation.test.ts` gained a full private-category
  IDOR suite (sibling-category member, project-only member, and CLIENT
  all correctly denied, including via manually-supplied column/task IDs);
  `test/activity-and-analytics.test.ts` gained explicit leak-proof tests
  for both the activity feed and analytics filters; `test/realtime-eviction.test.ts`
  gained a dedicated category-room-scoping test (a socket that loses its
  `CategoryMembership` stops receiving that category's events immediately,
  even while still connected to the parent project's room).

**Scaffolded, not exhaustive:** dependencies (`TaskDependency`) remain
project-scoped, not category-scoped — a task in one category can depend
on a task in a sibling category of the same project, which was a
deliberate choice to avoid over-constraining an already-existing Phase 2
feature that wasn't called out as in-scope for this change. There is no
bulk "move all tasks from category A to category B" affordance; moving a
task between categories today would require deleting and recreating it
(out of scope for this pass).

## After Phase 9 — visual polish and the task-completion checkbox

Development continued after Categories landed, but as a series of focused
feature/fix commits rather than another numbered phase — there wasn't a
new architectural tier to introduce, so forcing one into the phase
structure would have been ceremony for its own sake. This section closes
out the history honestly rather than leaving it stop mid-story.

**Tailwind CSS + responsive-layout fixes.** Tailwind was layered in as a
utility toolkit (`tailwind.config.js`, `postcss.config.js`, `@tailwind`
directives in `apps/web/src/styles.css`) alongside the existing
hand-written `ph-*` design system — not a replacement for it, and its
colors/theming were left untouched. Tailwind utilities were then used to
fix concrete layout bugs found by reading each page/component: the Kanban
board's Board/Activity/Analytics sub-navigation could overflow on narrow
screens for lack of flex-wrap; analytics bar-chart label columns
(workload/status/priority/milestone breakdowns) could overflow on long
labels for lack of `min-width: 0`/truncation, worse on the narrower mobile
grid; and project/category/workspace list rows could have their layout
distorted by long names for lack of `truncate`/`shrink-0` on the name and
status/role badge.

**Visual redesign.** The frontend was functionally complete but visually
plain — flat cards, tiny Unicode glyphs standing in for drag/rename/
delete/close icons, unstyled selects, no shadows or button hierarchy. This
pass evolved the existing `--ph-*` design system rather than replacing it:
a richer indigo brand palette (`#4F46E5` light / `#6366F1` dark) with a
subtle gradient on primary buttons and the brand mark, layered on top of
the existing sky-blue-family palette; real layered elevation
(`--ph-shadow-sm/md/lg`) on every card/column/task-card/modal/dropdown,
with a smooth hover-lift on interactive rows; a clear primary/secondary/
ghost-icon button hierarchy, with ghost/icon buttons (drag handle, rename,
delete, close) getting consistent 30-34px hit targets; and hand-written
SVG icons (`apps/web/src/components/Icons.tsx`) replacing the Unicode
glyphs. Dark mode (Phase 7) was preserved and re-verified across the new
palette/elevation, not reworked.

**Optional custom column color.** `BoardColumn` gained a nullable `color`
field (hex string), independent of the existing todo/in_progress/done
`category` enum classification, so two columns that share a category
bucket (e.g. two "in_progress" columns) can look different, or a user can
simply pick a color they like. It's set via a native `<input
type="color">` in the add-column/rename-column forms with a "reset to
default" clear button; unset falls back to the existing category-based
default color.

**Task-completion checkbox with per-column revertible history.** Tasks
can now be checked off independently of which column they sit in.
Checking a task sets `Task.completedAt` — the same field `moveTask`
already set automatically on a done-category column transition — without
moving the task's `columnId`; the task then disappears from that column's
normal list into that same column's "History" panel, from which it can be
reverted (clearing `completedAt` again). This also fixed a real bug in the
analytics engine: `isDoneTask` (and the dependency-blocking checks in
`apps/api/src/analytics/analytics.service.ts`) previously keyed off the
task's current column category for most metrics, which meant a
checkbox-completed task sitting in a non-done column was undercounted
everywhere except `averageCompletionTimeHours`/`completedOverTime` (the
two metrics that already read `completedAt` directly). Every metric now
keys off `completedAt` alone, consistently, per the doc comment above
`isDoneTask`.
