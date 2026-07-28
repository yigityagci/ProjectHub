# Security Policy

ProjectHub is a self-hosted, multi-tenant-within-a-single-deployment
collaboration app whose dominant risk is workspace isolation / IDOR (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), section 4, for the full
security risk register and mitigations). We take reports seriously and
would rather hear about a problem privately than have it discovered in the
wild.

## Supported versions

ProjectHub is pre-1.0. There is no formal long-term-support/backport
policy yet: security fixes are applied to the `main` branch, and the most
recently released version is the only one that receives fixes. Once this
project reaches a stable 1.0 release cadence, this section will be updated
with a real support-window table (e.g. "the last two minor versions").
Self-hosters should track `main`/tagged releases and upgrade promptly when
a security fix is published.

## Reporting a vulnerability

Please do **not** open a public GitHub issue, discussion, or pull request
for a security vulnerability - that discloses it to everyone, including
anyone who might exploit it against an existing self-hosted instance
before a fix ships.

Instead, report it privately using one of the following channels:

1. **Preferred:** open a [GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
   on this repository (the repository's "Security" tab -> "Report a
   vulnerability"). This creates a private discussion thread visible only
   to you and the maintainers, and supports coordinated disclosure and CVE
   assignment if warranted.
2. **Alternative:** email `security@projecthub.example` (a placeholder
   address - replace with a real, monitored inbox before a public 1.0
   release) with:
   - A clear description of the vulnerability and its impact.
   - Steps to reproduce it (a minimal repro against a local
     `docker-compose up` instance is ideal).
   - Any relevant logs, request/response captures, or proof-of-concept
     code.
   - **Do not** include real user data, production credentials, or
     anything from a live instance you don't own in your report.

Please give us a reasonable opportunity to investigate and ship a fix
before any public disclosure.

### What to expect after reporting

- **Acknowledgment:** we aim to acknowledge a new report within 5 business
  days.
- **Triage:** we'll confirm whether the report is in scope (see below) and
  give an initial severity assessment.
- **Fix and disclosure:** once a fix is available, we'll coordinate a
  disclosure timeline with the reporter - typically, we'll ask for a short
  embargo period to let self-hosters actually upgrade before full public
  details are published, and we're happy to credit the reporter (by name
  or pseudonym, or anonymously if preferred) in the eventual advisory.

This is a best-effort process run by a small open-source team, not a
funded bug-bounty program - there is no monetary reward, but we do value
and will credit responsible disclosure.

## Scope

**In scope** - vulnerabilities in ProjectHub's own code affecting:

- Authentication and session management (registration, login, logout,
  first-admin setup, session revocation).
- CSRF protection.
- Workspace/project isolation and RBAC permission enforcement (any way to
  read, modify, or delete another workspace's or another project's data
  that you shouldn't have access to).
- The real-time (Socket.IO) layer - room-join authorization, event
  leakage across workspace/project boundaries.
- File upload/attachment handling (path traversal, content-type/size
  bypass, unauthorized download).
- Invitation token handling.
- Rate limiting / brute-force protections.
- Audit logging integrity (e.g. a way to perform a security-relevant
  action without it being logged, or to inject unsanitized data into a log
  entry).
- Mass-assignment / input-validation bypasses (e.g. setting `workspaceId`,
  `role`, `ownerId`, or similar server-derived fields via a crafted
  request body).

**Out of scope:**

- Vulnerabilities that require access to the host machine, the database,
  or the `.env` file directly (the operator/host is a trusted party in
  this threat model - see `docs/ARCHITECTURE.md` section 1).
- Denial-of-service via sheer resource exhaustion against a
  self-hoster's own instance (rate limiting is best-effort, not a DoS
  guarantee).
- Missing security headers/best-practice suggestions with no demonstrated
  exploitable impact (feel free to open a regular issue for these instead
  - they're welcome, just not a "vulnerability report").
- Issues solely in third-party dependencies with no ProjectHub-specific
  exploitable impact (please report those upstream; if you believe
  ProjectHub's *usage* of a dependency makes it exploitable here, that
  part is in scope).

## Security-relevant development practices

For contributors: see [`CONTRIBUTING.md`](CONTRIBUTING.md)'s "Security
expectations for contributions" section - workspace isolation, `.strict()`
input validation, and the 404-not-403 convention are non-negotiable in any
PR touching authorization.
