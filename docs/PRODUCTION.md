# Production deployment guide

This document is the practical, "I'm actually putting this on a real
server" companion to [`ARCHITECTURE.md`](ARCHITECTURE.md) (design/security
rationale) and [`PHASES.md`](PHASES.md) (what's built). It covers required
configuration, a reverse proxy in front of the stack (the single most
common real-world self-hosting failure point for this stack is a
misconfigured proxy dropping WebSocket upgrade headers - see below),
HTTPS/cookie security, and troubleshooting.

## 1. Required environment variables

Copy [`.env.example`](../.env.example) to `.env` and fill it in. Every
variable the API reads is Zod-validated at boot (`apps/api/src/config/env.ts`)
and the process refuses to start with an invalid configuration - if you
misconfigure something, you'll get a clear startup error, not a silent
half-working instance.

**Must be changed from the example before any real deployment:**

| Variable | Why |
|---|---|
| `POSTGRES_PASSWORD` / `DATABASE_URL` | The example is a placeholder; using it means anyone who can reach your Postgres port can log in with a well-known password. |
| `APP_SECRET` | Derives CSRF tokens and other server-side secrets. Must be >= 32 random characters (`openssl rand -base64 48` is a good generator). The app **refuses to boot in production** with the example value or anything under 32 characters. |
| `APP_URL` | The public URL the API is reachable at. Baked into the web UI's build (`VITE_API_URL`) so the browser knows where to send API/Socket.IO requests - see the reverse proxy section below for why this usually wants to be the *same* public hostname as the web UI, not a separate one. |
| `WEB_URL` | The public URL of the frontend, used to build invitation-accept links in emails. |
| `COOKIE_SECURE` | Set to `true` for any deployment served over HTTPS (which every real deployment should be - see section 3). |
| `CORS_ORIGIN` | Must match the frontend's actual public origin, or the browser will reject cross-origin API calls. |

**Worth reviewing, sensible defaults otherwise:**

| Variable | Purpose |
|---|---|
| `SESSION_TTL_HOURS` / `SESSION_ABSOLUTE_TTL_HOURS` | Idle vs. hard session expiry. |
| `RATE_LIMIT_LOGIN_MAX` / `RATE_LIMIT_LOGIN_WINDOW_MINUTES` | Login brute-force throttling (Redis-backed, survives restarts). |
| `RATE_LIMIT_GLOBAL_MAX` / `RATE_LIMIT_GLOBAL_WINDOW_MINUTES` | Overall per-IP request throttling. |
| `INVITE_TTL_HOURS` | How long an invitation link stays valid. |
| `ARGON2_MEMORY_COST_KIB` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM` | Password hashing cost. The `.env.example` defaults are reasonable for a small VPS; raise `ARGON2_MEMORY_COST_KIB` if your server has memory to spare and you want stronger hashing. |
| `UPLOAD_DIR` | Where the local-disk `StorageProvider` (Phase 4) writes attachments - must match the `uploads` volume mount in `docker-compose.yml` (it does, by default). |
| `UPLOAD_MAX_SIZE_BYTES` | Max attachment size, enforced by `@fastify/multipart` (default 25 MB). |

**Outbound email is no longer an environment variable.** It's configured at
runtime, per-installation, by a platform administrator from Platform
Settings > ProjectHub Administration (`/settings/projecthub-admin` in the web UI, backed by
`GET/PATCH/DELETE /api/platform/email-config` and gated by
`User.isPlatformAdmin`, see `apps/api/src/rbac/guards.ts#requirePlatformAdmin`).
The SMTP password is encrypted at rest (AES-256-GCM, key derived from
`APP_SECRET` via HKDF - see `apps/api/src/core/secret-box.ts`) and is never
returned by any API response. **Rotating `APP_SECRET` after email has been
configured permanently invalidates the stored SMTP password** - the app
degrades gracefully (falls back to logging emails to the console, exactly
like the unconfigured state) and an admin must re-enter it. Until email is
configured and enabled, invitation/password-reset/notification emails are
logged to the API's console instead of sent - fine for evaluation, not for
real onboarding of real users who won't have console access. The Platform
Settings > Email page also includes built-in SPF/DKIM/DMARC/PTR DNS
deliverability guidance.

Redis (`REDIS_URL`) needs no additional configuration beyond what's already
in `docker-compose.yml` - it's used for rate limiting, sessions-adjacent
caching, and as the `@socket.io/redis-adapter` backing store for
multi-process Socket.IO fan-out. There is nothing Socket.IO-specific to
configure beyond `REDIS_URL` itself.

## 2. Reverse proxy (TLS termination + WebSocket upgrade)

Self-hosters typically want ProjectHub reachable at a single public
hostname over HTTPS, with a reverse proxy terminating TLS and forwarding
to the `web` (port 5173) and `api` (port 4000) containers published by
`docker-compose.yml`. Path-based routing on one hostname is the simplest
setup and is what the examples below use: `/` -> web UI, `/api/*` and
`/socket.io/*` -> API. Point `APP_URL`, `WEB_URL`, and `CORS_ORIGIN` in
`.env` all at that one public hostname (e.g. `https://projecthub.example.com`)
and rebuild the web image (`docker-compose build web`) so the correct
`VITE_API_URL` is baked into the browser bundle.

### Why the WebSocket headers matter (read this before deploying)

The Phase 3 real-time layer is Socket.IO, mounted at the fixed path
`/socket.io` on the API server (see `apps/api/src/realtime/realtime.ts` and
the matching client config in `apps/web/src/lib/socket.ts`). A WebSocket
connection starts as a normal HTTP request that asks to be **upgraded** via
the `Upgrade: websocket` and `Connection: Upgrade` request headers. If a
reverse proxy in front of the API does not forward those two headers (and
use HTTP/1.1, since HTTP/1.0 has no `Upgrade` mechanism), the upgrade
handshake fails. Socket.IO is resilient enough that this usually doesn't
look like an outright error to the end user - it silently falls back to
(or gets stuck endlessly retrying) HTTP long-polling, or repeatedly
disconnects/reconnects - so real-time task/board/notification updates stop
working, or work erratically, with no obvious error message pointing at
the cause. **This is the single most common real-world self-hosting
failure point for this stack.** Both example configs below get this right;
if you write your own, copy the `/socket.io/*` block exactly.

### nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name projecthub.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name projecthub.example.com;

    ssl_certificate     /etc/letsencrypt/live/projecthub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/projecthub.example.com/privkey.pem;

    # Frontend (the `web` container's static build server)
    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # REST API
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Socket.IO real-time layer. proxy_http_version 1.1 plus the Upgrade/
    # Connection headers are REQUIRED for the WebSocket handshake to
    # succeed - see "Why the WebSocket headers matter" above.
    location /socket.io/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket connections are long-lived. The default
        # proxy_read_timeout (60s) will silently kill an idle-but-healthy
        # connection well before Socket.IO's own ping/pong keepalive
        # (25s interval / 20s timeout by default) would ever need to.
        proxy_read_timeout 3600s;
    }
}
```

If nginx itself runs inside Docker on the same user-defined network as the
`api`/`web` services (instead of on the host proxying to published ports),
replace `127.0.0.1:4000`/`127.0.0.1:5173` with the service names `api:4000`
/`web:5173` - everything else is identical.

### Caddy

Caddy is a good alternative if you want automatic HTTPS certificate
provisioning/renewal with essentially no configuration, and its
`reverse_proxy` directive forwards WebSocket upgrade headers **automatically**
- there is no separate WebSocket-specific directive needed, unlike nginx:

```
projecthub.example.com {
    encode gzip

    handle /socket.io/* {
        reverse_proxy 127.0.0.1:4000
    }

    handle /api/* {
        reverse_proxy 127.0.0.1:4000
    }

    handle {
        reverse_proxy 127.0.0.1:5173
    }
}
```

That's a complete, working config - Caddy obtains and renews a
Let's-Encrypt certificate for `projecthub.example.com` on its own.

## 3. HTTPS and cookie security

ProjectHub authenticates every request via an opaque, server-side session
token in an `httpOnly` cookie (never a JWT - see `docs/ARCHITECTURE.md`
section 2 for why), with CSRF protection via a second, readable
double-submit cookie. Two environment variables control cookie behavior:

- **`COOKIE_SECURE=true`** - marks the session cookie `Secure`, meaning
  browsers will only ever send it over HTTPS. **Set this to `true` for any
  deployment reachable over the public internet.** Leave it `false` only
  for pure local development over plain `http://localhost`. Serving
  authenticated traffic over plain HTTP in production would let the
  session cookie (and everything else) be read by anyone on the network
  path - always terminate TLS at the reverse proxy (section 2) and set
  this to `true` to match.
- **`CORS_ORIGIN`** - must exactly match the frontend's real origin (with
  the reverse-proxy setup above, that's the same `https://` hostname the
  web UI is served from). A mismatch here doesn't just break CORS
  cosmetically - it's the boundary that keeps some other origin from
  making authenticated cross-origin requests against your instance.

The session cookie is always `SameSite=Lax` and `httpOnly`; there is no
environment variable for these because they should never be relaxed.

## 4. Troubleshooting

**"Database connection refused" / API container keeps restarting on boot**

- Confirm the `db` service reports healthy: `docker-compose ps` (its
  healthcheck is `pg_isready`). The `api` service's own `depends_on:
  condition: service_healthy` should already prevent it from starting
  before `db` is ready, so this usually means `db` itself failed to start
  - check `docker-compose logs db` for a Postgres startup error (often a
  stale/corrupt `pgdata` volume from an interrupted previous run, or a
  `POSTGRES_PASSWORD` mismatch between the volume's existing data and the
  current `.env`, e.g. after previously bringing the stack up with a
  different password).
- Confirm `DATABASE_URL` in `.env` actually matches
  `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` (they're independently
  overridable, but must agree - `docker-compose.yml` expects all four to
  describe the same database).

**"relation ... does not exist" / migrations not applied**

- The `api` container's entrypoint runs `prisma migrate deploy` before
  starting the server (see `apps/api/Dockerfile`'s `CMD`), so this should
  self-heal on every container start/restart. If you still see this:
  check `docker-compose logs api` for a migration error (most commonly:
  the database user lacks `CREATE`/`ALTER` privileges on the schema, or a
  previous manual/partial migration left the `_prisma_migrations` table in
  an inconsistent state). As a last resort for a genuinely stuck
  migration history on a non-production instance, restoring from a known
  good backup (`docs/BACKUP_AND_RESTORE.md`) is safer than hand-editing
  `_prisma_migrations`.

**Real-time updates (Kanban board, notifications, activity feed) don't
work, or only work sometimes**

- This is almost always the reverse proxy dropping the WebSocket upgrade
  headers on the `/socket.io/*` path - see section 2 above. Open the
  browser devtools Network tab, filter for `socket.io`, and check: is it
  stuck on repeated `polling` requests instead of upgrading to
  `websocket`? Are `/socket.io/` requests returning `400`/`502` from the
  proxy? Fix the proxy config first.
- Confirm `CORS_ORIGIN` matches the page's actual origin - a CORS
  rejection on the initial handshake looks similar to a WebSocket-upgrade
  failure in the browser console.
- Confirm Redis is reachable (`redis-cli -u "$REDIS_URL" ping`) - the
  `@socket.io/redis-adapter` needs it for cross-process broadcast if you
  ever run more than one API instance/process.

**File uploads fail (Phase 4 attachments)**

- **Disk full:** the local-disk `StorageProvider` writes into the
  `uploads` named volume; if the host's disk backing that volume fills up,
  writes fail. Check `df -h` on the host and the volume's actual backing
  path (`docker volume inspect <project>_uploads`).
- **Missing/misconfigured volume:** confirm the `uploads` volume is
  actually declared and mounted (`docker-compose.yml` already does this by
  default - don't remove it if you're customizing the compose file) and
  that `UPLOAD_DIR` (default `uploads`) hasn't been pointed somewhere the
  process can't write to.
- **File too large / wrong type:** these are enforced deliberately
  (`UPLOAD_MAX_SIZE_BYTES`, and a content-type allowlist in
  `packages/shared/src/dto/attachment.ts`) and return a clear `4xx` error
  to the client, not a silent failure - if uploads of a reasonable size and
  common type are being rejected, check those two things first before
  assuming it's a bug.

For anything else, `docker-compose logs -f api` (structured Pino JSON logs,
with secrets redacted per `docs/ARCHITECTURE.md`'s risk register) is the
first place to look.

## 5. Backups

See [`docs/BACKUP_AND_RESTORE.md`](BACKUP_AND_RESTORE.md).
