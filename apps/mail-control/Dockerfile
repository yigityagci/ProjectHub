# ProjectHub self-hosted Postfix + mail-control listener image.
# Build context MUST be the repo root (see docker-compose.yml's
# `postfix.build.context: .`), since this needs the shared workspace
# package.json/lockfile for a reproducible `pnpm install`.
#
# SECURITY-LOAD-BEARING PROCESS-USER DECISION (see apps/mail-control's
# top-level design notes / architecture handoff item 9.2): the mail-control
# listener runs as a dedicated non-root user, `mailctl`, NOT root. This is
# the "attempt the non-root approach first" path — it was successfully
# implemented (not the root-fallback), via:
#   1. A narrow `sudoers.d` NOPASSWD allowlist for EXACTLY three
#      invocations `mailctl` can run as root: `postfix -c
#      /etc/postfix.staging check`, `postfix reload`, and `postconf` (any
#      arguments — postconf itself never accepts a caller-named parameter,
#      see src/postfix.ts#buildPostconfArgs, which is the real boundary).
#   2. Ordinary Unix GROUP permissions (not sudo) for everything else this
#      process needs to touch as a file owner/group member: `mailctl` is
#      added to the `postfix` group (so it can create/write
#      /etc/postfix.staging and promote main.cf — see
#      src/postfix.ts#stageConfigDir/#promoteStagedConfig, which are plain
#      Node `fs` calls, not execFile) and to the `opendkim` group (so it
#      can write DKIM private key files readable by the `opendkim` daemon
#      — see src/opendkim.ts's doc comment for why this is mode 0640
#      group-readable rather than literally chowned to `opendkim`, which
#      would need root). `postqueue`/`sendmail` work for any local user
#      out of the box via Debian's postfix package's own setgid
#      `postdrop` mechanism — no extra permission needed for those.
#   3. Group ownership of the supervisor control socket (see
#      supervisord.conf's `[unix_http_server]` block) so `mailctl` can run
#      `supervisorctl status`/`restart` without root.
# `security_opt: no-new-privileges` is NOT used on this container (see
# docker-compose.yml) — Postfix's own master process needs setuid to spawn
# its unprivileged children, and this image's own `sudo` escalation for
# `mailctl` would also be blocked by it.

FROM node:20-bookworm-slim AS builder
RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Sibling package.json files are copied too (even though this image only
# builds @projecthub/mail-control) purely for pnpm workspace lockfile
# parity — `pnpm install --frozen-lockfile --filter` still resolves the
# full workspace graph from pnpm-lock.yaml before filtering.
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/mail-control ./apps/mail-control
RUN pnpm install --frozen-lockfile --filter @projecthub/mail-control
RUN pnpm --filter @projecthub/mail-control run build

# -----------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive

# Pre-seed debconf so `postfix`'s postinst doesn't block on an interactive
# "General type of mail configuration" prompt during `apt-get install`.
# "Internet Site" is overwritten entirely by main.cf.base/docker-entrypoint.sh
# at every container boot anyway — this seed only affects the one-time
# package install step.
RUN echo "postfix postfix/main_mailer_type select Internet Site" | debconf-set-selections \
  && echo "postfix postfix/mailname string localhost" | debconf-set-selections

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       postfix \
       postfix-pcre \
       opendkim \
       opendkim-tools \
       supervisor \
       sudo \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Node binary only (no npm/corepack needed at runtime) — copied from the
# builder stage rather than apt-installing nodejs, avoiding a second
# package source. Both stages are Debian bookworm, so the shared libs
# (libstdc++6/libgcc-s1) node's binary links against are already present
# in the runtime image via its own base packages.
COPY --from=builder /usr/local/bin/node /usr/local/bin/node

# --- mailctl: the unprivileged user that runs the control listener -------
RUN groupadd --system mailctl \
  && useradd --system --gid mailctl --home-dir /home/mailctl --no-create-home --shell /usr/sbin/nologin mailctl \
  && mkdir -p /home/mailctl \
  && usermod -aG postfix,opendkim mailctl

# Narrow, exact NOPASSWD sudoers allowlist (see the header comment above).
# Deliberately a file in sudoers.d, not an edit to /etc/sudoers directly.
RUN printf '%s\n' \
    'Defaults:mailctl !requiretty' \
    'mailctl ALL=(root) NOPASSWD: /usr/sbin/postfix -c /etc/postfix.staging check' \
    'mailctl ALL=(root) NOPASSWD: /usr/sbin/postfix reload' \
    'mailctl ALL=(root) NOPASSWD: /usr/sbin/postconf *' \
    > /etc/sudoers.d/mailctl \
  && chmod 0440 /etc/sudoers.d/mailctl \
  && visudo -c

# Group-writable /etc/postfix (setgid so files created by mailctl stay
# group=postfix) so the plain `fs.rm`/`fs.cp`/`fs.copyFile` staging calls
# in src/postfix.ts work without sudo.
RUN chgrp -R postfix /etc/postfix \
  && chmod -R g+w /etc/postfix \
  && find /etc/postfix -type d -exec chmod g+s {} \;

# /etc/postfix.staging (src/postfix.ts's STAGING_DIR) needs the SAME
# treatment, pre-created here rather than left for stageConfigDir() to
# `mkdir` at runtime: `/etc` itself is root-owned 755, so mailctl (a
# non-root user, not in a group that owns /etc) gets EACCES trying to
# create a new entry directly under it. stageConfigDir() below is written
# to only ever clear this directory's *contents*, never remove the node
# itself, so this one-time ownership grant survives every later apply.
RUN mkdir -p /etc/postfix.staging \
  && chgrp postfix /etc/postfix.staging \
  && chmod g+ws /etc/postfix.staging

# opendkim's own key directory: group-owned + setgid so DKIM key files
# mailctl writes are group-readable by the opendkim daemon (see
# src/opendkim.ts's doc comment on the 0640/group-permission design).
RUN mkdir -p /etc/opendkim/keys \
  && chgrp -R opendkim /etc/opendkim \
  && chmod -R g+w /etc/opendkim \
  && chmod g+s /etc/opendkim/keys

COPY --from=builder /workspace/apps/mail-control/dist /opt/mail-control
COPY apps/mail-control/main.cf.base /etc/postfix/main.cf.base
COPY apps/mail-control/opendkim.conf /etc/opendkim.conf
COPY apps/mail-control/supervisord.conf /etc/supervisor/conf.d/mail-control.conf
COPY apps/mail-control/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# NO EXPOSE, no published port anywhere in this image or in
# docker-compose.yml — reachability is governed entirely by Docker network
# topology (the private, `internal: true` `mail-control` network).
# `master.cf` is NEVER copied/touched by this image at any point.

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:8025/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
