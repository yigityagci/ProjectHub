# ProjectHub

ProjectHub is an open-source, self-hosted project management platform. It
lets individuals, teams, and companies run their own project management
tool without depending on a third-party SaaS provider.

This repository implements the full v1 scope across nine phases (all
implemented as of this writing), plus a round of visual/UX work that
shipped afterward outside the numbered-phase structure - see
[`docs/PHASES.md`](docs/PHASES.md) for what each phase (and the post-Phase-9
work) delivered, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the
architecture, data model, and security design.

## Features

- **Auth, workspaces, RBAC** - self-hosted authentication with server-side
  sessions (instantly revocable, never JWTs), first-admin bootstrap,
  multi-workspace membership, six system roles (Owner/Administrator/
  Project Manager/Member/Viewer/Client) with a granular permission
  catalog, invitation tokens, and an append-only security audit log.
- **Categories - a required Project -> Category -> Task isolation tier** -
  every project is divided into one or more Categories (think of them as
  folders inside a project), each with its **own** Kanban board, its own
  columns, and its own `workspace`/`private` visibility and membership
  list, mirroring the project-level access model one level down. A
  brand-new project starts with zero categories and forces you through a
  "create your first category" step before it can be used; a project card
  then links to a category picker rather than a board directly.
- **Projects, tasks, subtasks, Kanban** - full CRUD on projects, categories,
  board columns, tasks (with one-level subtasks, priorities, dates, labels,
  milestones, and dependencies), optimistic concurrency on task edits/
  moves, and a drag-and-drop Kanban board scoped to each category.
- **Task completion checkbox with per-column history** - tasks can be
  checked off independently of which column they sit in. Checking a task
  sets its completion timestamp without moving it to a different column;
  it disappears from that column's normal list into that same column's
  revertible "History" panel. Completion is tracked consistently through
  the analytics engine regardless of which column a task currently sits
  in.
- **Custom column colors** - each board column can optionally be given its
  own accent color, independent of its todo/in-progress/done
  classification, in addition to the built-in category-based default
  colors.
- **Real-time collaboration** - a push-only Socket.IO layer broadcasts
  every mutation live to everyone viewing the same workspace/project/
  category, authenticated via the same session cookie as the REST API,
  with immediate room eviction on permission loss.
- **Comments, mentions, notifications, attachments** - task comments with
  `@mention` autocomplete, a notification bell (mentions, task
  assignments), and file attachments served only through an authorized
  download endpoint (never a static/public file path).
- **Activity feed & audit log** - a user-facing, per-project (and
  per-category) activity feed (task created/moved/assigned, comments,
  milestones) alongside (and never mixed with) the separate security
  audit log.
- **Analytics & health status** - real operational metrics (completion
  rate, overdue/blocked counts, workload by assignee, completion-time
  trends, milestone progress) plus a deterministic, rule-based (not
  AI-based) project health classification with a human-readable,
  data-backed explanation.
- **Search & filter** - substring search and multi-field filtering on the
  projects list and the Kanban board (title/description, status,
  priority, assignee, label, overdue, subtasks), always composed with
  (never replacing) the existing workspace/project/category access
  scoping.
- **Light/dark theming** - a full dark mode (not a filter/invert hack)
  covering every page, defaulting to the OS/browser's `prefers-color-scheme`
  and overridable via a toggle in the app shell, persisted per-browser.
- **Responsive layout** - the Kanban board, task modal, projects list,
  category picker, analytics dashboard, activity feed, and notification
  dropdown all work on mobile/tablet-width viewports.
- **Visual design** - an indigo brand palette, layered card/modal/dropdown
  elevation, a consistent primary/secondary/ghost-icon button hierarchy,
  and hand-written SVG icons, built on Tailwind CSS layered alongside a
  hand-written `ph-*` design system.

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript, end to end |
| Backend | [Fastify](https://fastify.dev/) 5, [Prisma](https://www.prisma.io/) 5 ORM/migrations over PostgreSQL 16 |
| Real-time | [Socket.IO](https://socket.io/) 4 + `@socket.io/redis-adapter` for multi-process fan-out |
| Cache / rate-limit | Redis (via `ioredis`, `@fastify/rate-limit`) |
| Auth | Server-side sessions (opaque tokens, argon2id password hashing via `argon2`), never JWTs |
| Validation / contracts | [Zod](https://zod.dev/), shared between frontend and backend via `packages/shared` |
| API docs | OpenAPI/Swagger (`@fastify/swagger` + `@fastify/swagger-ui`) |
| Frontend | [React](https://react.dev/) 18 + [Vite](https://vitejs.dev/) 5 SPA, `react-router-dom` |
| Drag-and-drop | [`@dnd-kit`](https://dndkit.com/) (core/sortable/utilities) |
| Styling | [Tailwind CSS](https://tailwindcss.com/) 3, layered alongside a hand-written `ph-*` design system |
| Testing | [Vitest](https://vitest.dev/) (integration-style, against a real Postgres + Redis) |
| Package manager / monorepo | [pnpm](https://pnpm.io/) workspaces (Node.js 20+) |
| Deployment | Docker Compose (Postgres + Redis + API + web, each with health checks) |

See the root `package.json`, `apps/api/package.json`, `apps/web/package.json`,
and `packages/shared/package.json` for exact dependency versions.

## Quick start (Docker Compose)

```bash
git clone <this-repo-url> projecthub
cd projecthub
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, APP_SECRET, and MAIL_CONTROL_TOKEN to
# strong random values (MAIL_CONTROL_TOKEN is required for `api` to boot
# even if you never enable self-hosted mail delivery - see .env.example).
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
   `POSTGRES_PASSWORD`, `APP_SECRET`, and `MAIL_CONTROL_TOKEN` to strong
   random values.
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
   API - the frontend exercises the accept flow, not the
   create-invitation form; see `POST /api/workspaces/:id/invitations` in
   `docs`/Swagger). Register a second browser session/incognito window
   with a different email, and accept the invitation via the emailed (or,
   without SMTP configured, console-logged - check `docker-compose logs api`)
   accept link.
7. **Create a project and its first category:** open "Projects" for the
   workspace and create one. Because a project starts with zero
   categories, you're immediately forced into a "create your first
   category" step (no skip/cancel) - name it and submit. This seeds the
   default three board columns (To Do / In Progress / Done) on that
   category's own Kanban board and takes you straight there.
8. **Add a second category (optional):** from the project's category
   picker, add another category (e.g. with `private` visibility) and
   confirm it gets its own independent board, separate from the first.
9. **Create and move tasks:** add a few tasks to different columns, open
   one to set its priority/description/assignee/labels, and drag a task
   between columns.
10. **Complete a task via the checkbox:** check off a task without moving
    it out of its current column, confirm it disappears from that
    column's normal list, then open that column's "History" panel and
    revert it back to incomplete.
11. **Try a custom column color:** set a custom accent color on a column
    (or clear it back to the category default) and confirm the board
    reflects it.
12. **Confirm real-time updates:** with the workspace open in two browser
    sessions (the owner and the invited member from step 6, both viewing
    the same category's board), move a task in one session and confirm it
    updates live in the other without a page refresh - this exercises the
    Socket.IO layer end-to-end, including the reverse proxy's WebSocket
    upgrade handling if you're testing behind one (see
    `docs/PRODUCTION.md` if this doesn't work).
13. **Comment and mention:** add a comment on a task mentioning the other
    member (`@` then their name); confirm they receive a notification
    (bell icon badge) and it appears live if their session is open.
14. **Attach a file:** upload a small file to a task and confirm it
    downloads correctly (and that a third, unauthenticated or
    unauthorized session cannot fetch it directly).
15. **Check the activity feed:** open the board's "Activity" tab and
    confirm the task-created/moved/assigned/commented events from the
    steps above appear, most-recent-first.
16. **Check analytics:** open "Analytics" for the project and confirm the
    stat cards, workload/status/priority breakdowns, and the health-status
    banner (should read "On Track" for a fresh project with no overdue/
    blocked tasks) all render with real numbers matching what you just
    created, correctly counting the task you completed via the checkbox
    in step 10 even though it never left its original column.
17. **Search/filter:** use the projects list search box and the Kanban
    board's filter bar to narrow results by name/title, status, priority,
    assignee, and label, and confirm the results are actually narrowed
    (not just cosmetically).
18. **Toggle dark mode:** use the theme toggle in the app shell and
    confirm every page visited above (board, modal, notifications,
    activity, analytics) renders correctly in both themes.
19. **Take a backup:** run `./scripts/backup.sh` and confirm it produces a
    non-empty `.sql.gz` and `.tar.gz` in `./backups/` (see
    `docs/BACKUP_AND_RESTORE.md`).

## Self-hosted mail delivery (optional)

By default, ProjectHub sends outbound mail via an external SMTP relay
configured at runtime from Settings > Platform Administration. As an
alternative, an admin can switch to a self-hosted Postfix instance that
ships as part of this repo (`apps/mail-control`), running in its own
container alongside a private control-plane listener the API talks to.

Self-hosted mode is entirely opt-in and requires the shipped Docker
Compose stack:

```bash
docker compose --profile postfix up -d
```

It is **not available** on the "Local development (without Docker)" path
below - there is no mail-control listener to talk to there, so Settings >
Mail Delivery reports self-hosted mode as unavailable and external SMTP
remains the only option.

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
  PHASES.md                Phase-by-phase roadmap (all 9 phases implemented, plus post-Phase-9 work)
  PRODUCTION.md            Production config, reverse proxy/WebSocket setup, troubleshooting
  BACKUP_AND_RESTORE.md    Database + uploads backup/restore procedure
scripts/
  backup.sh / restore.sh   Backup/restore scripts referenced above
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - constraints and risks,
  technology selection, the full data model, and the security risk
  register.
- [`docs/PHASES.md`](docs/PHASES.md) - what each of the nine phases (and
  the visual/UX work that shipped afterward) actually delivered, and what
  is honestly still scaffolding-tier rather than exhaustively hardened.
- [`docs/PRODUCTION.md`](docs/PRODUCTION.md) - environment variables that
  matter in production, reverse proxy (nginx/Caddy) configuration with
  correct WebSocket upgrade handling, HTTPS/cookie security, and
  troubleshooting.
- [`docs/BACKUP_AND_RESTORE.md`](docs/BACKUP_AND_RESTORE.md) - database
  and file-attachment backup/restore procedure using `scripts/backup.sh`/
  `scripts/restore.sh`.
- [`SECURITY.md`](SECURITY.md) - how to report a vulnerability, supported
  versions, and this project's in-scope/out-of-scope threat model.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) - local setup, repository
  conventions, and PR expectations.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) - community standards
  (Contributor Covenant v2.1).

## License

ProjectHub is licensed under the [Apache License 2.0](LICENSE). See
[NOTICE](NOTICE) for attribution.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
