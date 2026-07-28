# Security Policy

ProjectHub takes security seriously, especially given its focus on
strict server-side workspace isolation for self-hosted deployments. This
document is a stub for Phase 1 and will be expanded with a full
disclosure policy, supported-version table, and hardening checklist in
Phase 8.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security
vulnerabilities. Instead, report them privately using one of the
following channels:

1. **Preferred:** Open a [GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
   on this repository ("Security" tab -> "Report a vulnerability").
2. **Alternative:** Email the maintainers at
   `security@projecthub.example` (placeholder address — replace with a
   real monitored inbox before a public release) with a description of
   the issue, steps to reproduce, and any relevant logs or proof of
   concept. Please do not include real user data.

We aim to acknowledge reports within 5 business days. Once a fix is
available, we will coordinate a disclosure timeline with the reporter.

## Scope (Phase 1)

In scope for this phase: authentication, session management, CSRF
protection, workspace isolation (cross-tenant access control), RBAC
permission enforcement, invitation token handling, rate limiting, and
audit logging.

Out of scope for this phase (not yet built): real-time/WebSocket
transport, file uploads, analytics, and anything else listed as a later
phase in [`docs/PHASES.md`](docs/PHASES.md).

## Supported versions

ProjectHub is pre-1.0 and does not yet have a formal support/backport
policy. Security fixes are applied to the `main` branch.
