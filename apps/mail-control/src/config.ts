/**
 * Fixed, hardcoded limits/paths for the mail-control listener. Nothing
 * here is meant to be operator-tunable beyond the environment variables
 * actually read by index.ts (MAIL_CONTROL_TOKEN, MAIL_CONTROL_PORT,
 * POSTFIX_MYNETWORKS) — nothing in this file is exposed to the API.
 */

/** Enforced independently of the ProjectHub API's own body-size limits. */
export const MAX_BODY_BYTES = 32_768;

export const DEFAULT_PORT = 8025;

/** PATH passed to every execFile call — deliberately narrow, never inherits the parent process's PATH. */
export const SAFE_EXEC_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

export const EXEC_TIMEOUT_MS = 10_000;
export const EXEC_MAX_BUFFER_BYTES = 1 << 20;

export const MUTATING_RATE_LIMIT = { max: 10, windowMs: 5 * 60_000 };
export const READ_RATE_LIMIT = { max: 120, windowMs: 60_000 };

export const OUTBOUND_SMTP_PROBE_TARGETS: Array<{ host: string; port: number }> = [
  { host: "alt1.aspmx.l.google.com", port: 25 },
  { host: "mx01.mail.icloud.com", port: 25 },
];
export const OUTBOUND_SMTP_PROBE_TIMEOUT_MS = 5000;
export const OUTBOUND_SMTP_PROBE_CACHE_MS = 60_000;

export const QUEUE_CACHE_MS = 5000;
export const QUEUE_MAX_ENTRIES = 500;
export const QUEUE_MAX_RECENT_ERRORS = 20;
