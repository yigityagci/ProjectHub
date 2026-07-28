# ProjectHub

ProjectHub is an open-source, self-hosted project management platform. It
lets individuals, teams, and companies run their own project management
tool without depending on a third-party SaaS provider.

This repository implements the full v1 scope across eight phases (all
implemented as of this writing) - see [`docs/PHASES.md`](docs/PHASES.md)
for what each phase delivered and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for the architecture, data model, and security design.

## Features

- **Auth, workspaces, RBAC** - self-hosted authentication with server-side
  sessions (instantly revocable, never JWTs), first-admin bootstrap,
  multi-workspace membership, six system roles (Owner/Administrator/
  Project Manager/Member/Viewer/Client) with a granular permission
  catalog, invitation tokens, and an append-only security audit log.
- **Projects, tasks, subtasks, Kanban** - full CRUD on projects, board
  columns, tasks (with one-level subtasks, priorities, dates, labels,
  milestones, and dependencies), optimistic concurrency on task edits/
  moves, and a drag-and-drop Kanban board.
- **Real-time collaboration** - a push-only Socket.IO layer broadcasts
  every mutation live to everyone viewing the same workspace/project,
  authenticated via the same session cookie as the REST API, with
  immediate room eviction on permission loss.
- **Comments, mentions, notifications, attachments** - task comments with
  `@mention` autocomplete, a notification bell (mentions, task
  assignments), and file attachments served only through an authorized
  download endpoint (never a static/public file path).
- **Activity feed & audit log** - a user-facing, per-project activity feed
  (task created/moved/assigned, comments, milestones) alongside (and
  never mixed with) the separate security audit log from Phase 1.
- **Analytics & health status** - real operational metrics (completion
  rate, overdue/blocked counts, workload by assignee, completion-time
  trends, milestone progress) plus a deterministic, rule-based (not
  AI-based) project health classification with a human-readable,
  data-backed explanation.
- **Search & filter** - substring search and multi-field filtering on the
  projects list and the Kanban board (title/description, status,
  priority, assignee, label, overdue, subtasks), always composed with
  (never replacing) the existing workspace/project access scoping.
- **Light/dark theming** - a full dark mode (not a filter/invert hack)
  covering every page, defaulting to the OS/browser's `prefers-color-scheme`
  and overridable via a toggle in the app shell, persisted per-browser.
- **Responsive layout** - the Kanban board, task modal, projects list,
  analytics dashboard, activity feed, and notification dropdown all work
  on mobile/tablet-width viewports.

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

- Open `http://localhost:5173` in a browser - this is the web UI. Because
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

For a real (non-`localhost`) deployment - reverse proxy/TLS setup (and, in
particular, getting the WebSocket-upgrade headers right for the real-time
layer), which environment variables actually matter in production, and a
troubleshooting section - see [`docs/PRODUCTION.md`](docs/PRODUCTION.md).

## Self-host smoke test (manual QA checklist)

A precise, followable walkthrough of the full flow on a clean machine,
useful both for a first-time self-hoster and as a manual regression check
after changes. (This exact checklist has **not** been executed against a
real Docker Engine in this development environment - Docker has not been
available in any phase of this project's development - but every step
maps directly to a REST endpoint or UI flow that **is** covered by the
automated test suite; see `pnpm test`.)

1. **Clone and configure:**
   `git clone`, `cd projecthub`, `cp .env.example .env`, then set
   `POSTGRES_PASSWORD` and `APP_SECRET` to strong random values.
2. **Bring up the stack:** `docker-compose up -d`, then
   `docker-compose ps` until `db`, `redis`, `api`, and `web` all report
   `healthy`.
3. **Open the app:** visit `http://localhost:5173`. You should land on the
   first-admin setup page (confirms `GET /api/setup/status` reports
   `needsSetup: true` on an empty database).
4. **Create the first admin:** fill in name/email/password and submit.
   You should be logged in immediately and redirected to the workspaces
   page (confirms `POST /api/setup` + auto-login).
5. **Create a workspace:** use the "Create a new workspace" form. You
   should see it appear in your workspace list with an "OWNER" role badge.
6. **Invite a member:** from the workspace, create an invitation (via the
   API - the minimal frontend from Phase 1 exercises the accept flow, not
   the create-invitation form; see `POST /api/workspaces/:id/invitations`
   in `docs`/Swagger). Register a second browser session/incognito window
   with a different email, and accept the invitation via the emailed (or,
   without SMTP configured, console-logged - check `docker-compose logs api`)
   accept link.
7. **Create a project:** open "Projects" for the workspace and create one.
   Confirm the default three board columns (To Do / In Progress / Done)
   appear on its Kanban board.
8. **Create and move tasks:** add a few tasks to different columns, open
   one to set its priority/description/assignee/labels, and drag a task
   between columns.
9. **Confirm real-time updates:** with the workspace open in two browser
   sessions (the owner and the invited member from step 6, both viewing
   the same board), move a task in one session and confirm it updates
   live in the other without a page refresh - this exercises the Phase 3
   Socket.IO layer end-to-end, including the reverse proxy's WebSocket
   upgrade handling if you're testing behind one (see
   `docs/PRODUCTION.md` if this doesn't work).
10. **Comment and mention:** add a comment on a task mentioning the other
    member (`@` then their name); confirm they receive a notification
    (bell icon badge) and it appears live if their session is open.
11. **Attach a file:** upload a small file to a task and confirm it
    downloads correctly (and that a third, unauthenticated or
    unauthorized session cannot fetch it directly).
12. **Check the activity feed:** open the board's "Activity" tab and
    confirm the task-created/moved/assigned/commented events from the
    steps above appear, most-recent-first.
13. **Check analytics:** open "Analytics" for the project and confirm the
    stat cards, workload/status/priority breakdowns, and the health-status
    banner (should read "On Track" for a fresh project with no overdue/
    blocked tasks) all render with real numbers matching what you just
    created.
14. **Search/filter:** use the projects list search box and the Kanban
    board's filter bar to narrow results by name/title, status, priority,
    assignee, and label, and confirm the results are actually narrowed
    (not just cosmetically).
15. **Toggle dark mode:** use the theme toggle in the app shell and
    confirm every page visited above (board, modal, notifications,
    activity, analytics) renders correctly in both themes.
16. **Take a backup:** run `./scripts/backup.sh` and confirm it produces a
    non-empty `.sql.gz` and `.tar.gz` in `./backups/` (see
    `docs/BACKUP_AND_RESTORE.md`).

## Local development (without Docker)

Requirements: Node.js 20+, pnpm, a local PostgreSQL 16 instance, and a
local Redis instance.

```bash
corepack enable
pnpm install
cp apps/api/.env.example apps/api/.env   # if present, otherwise see .env.example
pnpm --filter @projecthub/api run prisma:migrate
pnpm dev:api    # starts the API on http://localhost:4000
pnpm dev:web    # starts the frontend on http://localhost:5173 (Vite dev server, proxies /api and /socket.io to the API)
```

## Running tests

```bash
pnpm test
```

(equivalent to `pnpm --filter @projecthub/api run test`). The API test
suite is integration-style (Vitest + Fastify's `inject()`) against a real
PostgreSQL + Redis instance, configured via the `DATABASE_URL`/
`REDIS_URL` environment variables (see `apps/api/test/setup.ts`).

To type-check and build the frontend: `pnpm --filter @projecthub/web run build`.

## Repository layout

```
apps/
  api/      Fastify + Prisma backend (@projecthub/api)
  web/      React + Vite frontend (@projecthub/web)
packages/
  shared/   Shared types, Zod DTOs, RBAC permission/role catalog (@projecthub/shared)
docs/
  ARCHITECTURE.md          Full architecture, data model, and security risk register
  PHASES.md                Phase-by-phase roadmap (all 8 phases implemented)
  PRODUCTION.md            Production config, reverse proxy/WebSocket setup, troubleshooting
  BACKUP_AND_RESTORE.md    Database + uploads backup/restore procedure
scripts/
  backup.sh / restore.sh   Backup/restore scripts referenced above
```

## License

ProjectHub is licensed under the [Apache License 2.0](LICENSE). See
[NOTICE](NOTICE) for attribution.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
