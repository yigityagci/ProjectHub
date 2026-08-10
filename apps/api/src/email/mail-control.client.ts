import { env } from "../config/env.js";
import { logger } from "../core/logger.js";
import { AppError, ValidationError } from "../core/errors.js";

/**
 * mail-control.client.ts — the ONLY module in the API permitted to cross
 * into the self-hosted Postfix control plane. Every route/service that
 * needs to talk to the mail-control listener must go through the
 * functions exported here; nothing else in apps/api should ever construct
 * a request to MAIL_CONTROL_URL directly.
 *
 * (a) Trust boundary. browser -> API (session cookie + requirePlatformAdmin)
 * -> THIS MODULE -> control listener (co-located with Postfix, see
 * apps/mail-control) -> Postfix. The user's session token NEVER leaves the
 * API process. This module authenticates to the listener with a completely
 * separate credential, `env.MAIL_CONTROL_TOKEN` — a deployment-provisioned
 * service credential (same provisioning pattern as POSTGRES_PASSWORD /
 * APP_SECRET, see .env.example) shared only between the `api` and
 * `postfix` containers — sent as `Authorization: Bearer <token>`. There is
 * no code path anywhere that forwards a user's session cookie, CSRF token,
 * or any other user-derived credential to the listener.
 *
 * (b) Why plain `fetch`, no new HTTP client dependency. The API already
 * has Node 20's built-in `fetch`/`AbortSignal.timeout` available at
 * runtime (see e.g. the existing Docker HEALTHCHECKs, which already rely
 * on global fetch). This module makes at most a handful of low-QPS admin-
 * triggered requests to a single fixed host on a private network — there
 * is no connection-pooling, retry-policy, or streaming requirement that
 * would justify pulling in undici/axios/got as a new dependency.
 *
 * (c) Retry asymmetry (deliberate, do not "simplify" to one policy).
 * Read-only ops (`readStatus`, `readQueueSummary`, `validateConfig`) retry
 * EXACTLY ONCE, and only on a connection-level failure (the fetch itself
 * throwing — DNS/connect/reset), never on any HTTP status the listener
 * actually returned. Mutating ops (`applyConfig`, `reloadPostfix`,
 * `sendControlTestEmail`) NEVER retry, for ANY reason: a retried
 * test-email double-sends to a real inbox, and a retried apply can
 * interleave two `postconf`/staging-dir writes against the same
 * `/etc/postfix.staging` directory (the listener's own single-mutating-op
 * mutex mitigates this server-side, but this client must not even attempt
 * to create the race in the first place).
 *
 * (d) Why a listener 401/403 maps to an API 500, never 401/403. A 401/403
 * returned to the BROWSER from a ProjectHub API route conventionally means
 * "your session expired" / "you lack permission" — that would be a false
 * and actively misleading diagnosis here, since the actual cause is always
 * an operator-configuration mismatch (MAIL_CONTROL_TOKEN differs between
 * the `api` and `postfix` containers), never anything about the calling
 * admin's own session or role. Mapping it to a 500
 * (MAIL_CONTROL_UNAUTHORIZED) keeps the error truthful and actionable.
 *
 * (e) What must NEVER be logged by this module: the request body of
 * `applyConfig`/`validateConfig` (carries the DKIM PEM in `dkim.privateKeyPem`
 * on apply), `env.MAIL_CONTROL_TOKEN` itself, and the base URL if it ever
 * carried embedded credentials (it doesn't today, but never assume). Only
 * `{ op, status, durationMs }` is logged per call — see `logResult` below.
 * `core/logger.ts`'s redact paths are defense-in-depth on top of this
 * discipline, not a substitute for it.
 *
 * (f) Explicit non-goals: no HTTP connection pooling/keep-alive tuning, no
 * circuit breaker, no streaming request/response bodies (every payload
 * here is small and JSON). None of these have a motivating use case at
 * this call volume (a handful of admin-triggered requests) — see
 * core/scheduler.ts's doc comment for the same "don't speculatively build
 * infrastructure with no current requirement" philosophy this module
 * follows.
 */

const MAX_RESPONSE_BYTES = 65536;

const TIMEOUTS_MS = {
  status: 5000,
  queue: 5000,
  validate: 5000,
  sendTestEmail: 15000,
  apply: 25000,
  reload: 25000,
} as const;

export interface MailControlApplyPayload {
  sendingDomain: string;
  mailHostname: string;
  senderName: string;
  replyToAddress: string | null;
  dkim: { enabled: boolean; selector: string; privateKeyPem?: string } | null;
  limits: {
    destinationRateDelaySeconds: number;
    destinationConcurrencyLimit: number;
    messageSizeLimitBytes: number;
  };
}

export type MailControlValidatePayload = Omit<MailControlApplyPayload, "dkim"> & {
  dkim: { enabled: boolean; selector: string } | null;
};

export interface ApplyResult {
  ok: boolean;
  appliedAt?: string;
  postfixCheck?: { ok: boolean; warnings: string[] };
  reload?: { ok: boolean; durationMs: number };
  dkim?: { signingEnabled: boolean; selector: string };
  error?: string;
  details?: string[];
  rolledBack?: boolean;
  fieldErrors?: Record<string, string>;
}

export interface ValidateResult {
  ok: boolean;
  fieldErrors?: Record<string, string>;
  postfixCheck?: { ok: boolean; warnings: string[] };
  error?: string;
}

export interface ReloadResult {
  ok: boolean;
  durationMs?: number;
  error?: string;
}

export interface StatusResult {
  ok: boolean;
  processes?: Record<string, string>;
  postfixVersion?: string;
  appliedConfig?: Record<string, unknown>;
  outboundSmtp?: {
    checked: boolean;
    reachable: boolean;
    target: string | null;
    latencyMs: number | null;
    error: string | null;
    bestEffort: true;
    checkedAt: string;
  };
  checkedAt?: string;
  error?: string;
}

export interface QueueResult {
  ok: boolean;
  counts?: Record<string, number>;
  oldestArrivalAt?: string | null;
  recentErrors?: Array<{ queueId: string; arrivalAt: string; recipient: string; reason: string }>;
  truncated?: boolean;
  checkedAt?: string;
  error?: string;
}

export interface TestEmailResult {
  ok: boolean;
  queueId?: string | null;
  accepted?: boolean;
  sender?: string;
  error?: string;
}

export type SelfHostedAvailabilityReason = "ok" | "not_configured" | "unreachable" | "unauthorized";

export interface SelfHostedAvailability {
  available: boolean;
  reason: SelfHostedAvailabilityReason;
  detail: string;
  checkedAt: Date;
}

const AVAILABILITY_DETAIL: Record<SelfHostedAvailabilityReason, string> = {
  ok: "Self-hosted Postfix is reachable and ready.",
  not_configured:
    "Self-hosted Postfix requires the shipped docker-compose deployment. This instance is running outside that stack.",
  unreachable:
    "The Postfix service isn't running. Start it with `docker compose --profile postfix up -d`.",
  unauthorized: "MAIL_CONTROL_TOKEN differs between the api and postfix containers.",
};

/** module-level, deliberately (see file header (f) — no shared cache infra). */
let availabilityCache: { value: SelfHostedAvailability; expiresAt: number } | null = null;

function isConfigured(): boolean {
  return Boolean(env.MAIL_CONTROL_URL && env.MAIL_CONTROL_TOKEN);
}

function logResult(op: string, status: number | "error", durationMs: number): void {
  logger.info({ op, status, durationMs }, "Mail control request completed");
}

/**
 * Low-level request helper. `allowRetryOnConnectionError` must be true
 * ONLY for read-only ops (see file header (c)). Never logs the body,
 * token, or URL beyond the op name.
 */
async function request(
  op: string,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number; allowRetryOnConnectionError: boolean },
): Promise<unknown> {
  if (!env.MAIL_CONTROL_URL || !env.MAIL_CONTROL_TOKEN) {
    throw new AppError(
      503,
      "SELF_HOSTED_UNAVAILABLE",
      "Self-hosted Postfix requires the shipped docker-compose deployment. This instance is running outside that stack.",
    );
  }

  const url = `${env.MAIL_CONTROL_URL}${path}`;
  const attempt = async (): Promise<unknown> => {
    const start = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${env.MAIL_CONTROL_TOKEN}`,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(init.timeoutMs),
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      const isAbort = err instanceof Error && err.name === "TimeoutError";
      logResult(op, "error", durationMs);
      if (isAbort) {
        throw new AppError(503, "MAIL_CONTROL_TIMEOUT", "The mail-control service did not respond in time.");
      }
      throw new AppError(
        503,
        "MAIL_CONTROL_UNAVAILABLE",
        "Could not reach the mail-control service. Start the stack with `docker compose --profile postfix up -d`.",
      );
    }

    const durationMs = Date.now() - start;
    logResult(op, response.status, durationMs);

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_RESPONSE_BYTES) {
      throw new AppError(500, "MAIL_CONTROL_RESPONSE_TOO_LARGE", "The mail-control service returned an oversized response.");
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new AppError(500, "MAIL_CONTROL_RESPONSE_TOO_LARGE", "The mail-control service returned an oversized response.");
    }

    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    return mapResponse(response.status, parsed);
  };

  try {
    return await attempt();
  } catch (err) {
    // Only retry connection-level failures (503 MAIL_CONTROL_UNAVAILABLE),
    // and only for read-only ops — never on a real HTTP status the
    // listener returned, and never for mutating ops (see file header (c)).
    if (
      init.allowRetryOnConnectionError &&
      err instanceof AppError &&
      err.code === "MAIL_CONTROL_UNAVAILABLE"
    ) {
      return attempt();
    }
    throw err;
  }
}

interface ListenerErrorEnvelope {
  error?: { code?: string; message?: string; fieldErrors?: Record<string, string>; details?: string[] };
}

/** Maps a raw listener HTTP status + parsed body to either a return value or a thrown AppError. */
function mapResponse(status: number, body: unknown): unknown {
  if (status >= 200 && status < 300) {
    return body;
  }

  const envelope = (body ?? {}) as ListenerErrorEnvelope;
  const code = envelope.error?.code;
  const message = envelope.error?.message ?? "The mail-control service reported an error.";

  if (status === 401 || status === 403) {
    // Never surfaced to the browser as 401/403 — see file header (d).
    throw new AppError(500, "MAIL_CONTROL_UNAUTHORIZED", "MAIL_CONTROL_TOKEN differs between the api and postfix containers.");
  }
  if (status === 422) {
    throw new ValidationError(message, envelope.error?.fieldErrors);
  }
  if (status === 409) {
    throw new AppError(409, "MAIL_CONTROL_BUSY", "Another mail-control operation is already in progress. Try again shortly.");
  }
  if (status === 413) {
    throw new AppError(500, "MAIL_CONTROL_REQUEST_TOO_LARGE", "The request to the mail-control service was too large.");
  }
  if (status === 429) {
    // Deliberately NOT 429: server.ts's global error handler hardcodes a
    // login-attempt-specific message for every 429 response, so mapping
    // this to 429 would collide with that and show the wrong message.
    throw new AppError(503, "MAIL_CONTROL_BUSY", "The mail-control service is busy. Try again shortly.");
  }
  if (status === 404 && code === "UNKNOWN_OPERATION") {
    throw new AppError(500, "MAIL_CONTROL_VERSION_MISMATCH", "The mail-control service does not recognize this operation.");
  }
  if (status >= 500) {
    throw new AppError(502, "MAIL_CONTROL_ERROR", "The mail-control service reported an internal error.");
  }
  throw new AppError(502, "MAIL_CONTROL_ERROR", message);
}

export async function applyConfig(payload: MailControlApplyPayload): Promise<ApplyResult> {
  const result = await request("apply", "/v1/config/apply", {
    method: "POST",
    body: payload,
    timeoutMs: TIMEOUTS_MS.apply,
    allowRetryOnConnectionError: false,
  });
  return result as ApplyResult;
}

export async function validateConfig(payload: MailControlValidatePayload): Promise<ValidateResult> {
  const result = await request("validate", "/v1/config/validate", {
    method: "POST",
    body: payload,
    timeoutMs: TIMEOUTS_MS.validate,
    allowRetryOnConnectionError: true,
  });
  return result as ValidateResult;
}

export async function reloadPostfix(): Promise<ReloadResult> {
  const result = await request("reload", "/v1/reload", {
    method: "POST",
    body: {},
    timeoutMs: TIMEOUTS_MS.reload,
    allowRetryOnConnectionError: false,
  });
  return result as ReloadResult;
}

export async function readStatus(): Promise<StatusResult> {
  const result = await request("status", "/v1/status", {
    method: "GET",
    timeoutMs: TIMEOUTS_MS.status,
    allowRetryOnConnectionError: true,
  });
  return result as StatusResult;
}

export async function readQueueSummary(): Promise<QueueResult> {
  const result = await request("queue", "/v1/queue", {
    method: "GET",
    timeoutMs: TIMEOUTS_MS.queue,
    allowRetryOnConnectionError: true,
  });
  return result as QueueResult;
}

export async function sendControlTestEmail(recipient: string): Promise<TestEmailResult> {
  const result = await request("test-email", "/v1/test-email", {
    method: "POST",
    body: { recipient },
    timeoutMs: TIMEOUTS_MS.sendTestEmail,
    allowRetryOnConnectionError: false,
  });
  return result as TestEmailResult;
}

const AVAILABLE_TTL_MS = 60_000;
const UNAVAILABLE_TTL_MS = 15_000;

/**
 * Two AND-ed gates, in order:
 *   1. Config gate — env.MAIL_CONTROL_URL && env.MAIL_CONTROL_TOKEN both
 *      present. Zero network I/O. Short-circuits to `not_configured` under
 *      plain local (non-docker-compose) dev — this is what keeps the
 *      settings page fast and log-quiet outside the shipped stack.
 *   2. Reachability gate — GET /v1/status. Success also proves the shared
 *      credential is correct (a 401 there means a misconfigured token, not
 *      "unreachable" — see the `unauthorized` branch below).
 *
 * Cached for 60s on success / 15s on failure, module-level (single
 * process, matches the rest of this module's no-shared-cache-infra
 * stance — see file header (f)).
 */
export async function getSelfHostedAvailability(): Promise<SelfHostedAvailability> {
  const now = Date.now();
  if (availabilityCache && availabilityCache.expiresAt > now) {
    return availabilityCache.value;
  }

  if (!isConfigured()) {
    const value: SelfHostedAvailability = {
      available: false,
      reason: "not_configured",
      detail: AVAILABILITY_DETAIL.not_configured,
      checkedAt: new Date(),
    };
    availabilityCache = { value, expiresAt: now + UNAVAILABLE_TTL_MS };
    return value;
  }

  let reason: SelfHostedAvailabilityReason;
  try {
    await readStatus();
    reason = "ok";
  } catch (err) {
    reason = err instanceof AppError && err.code === "MAIL_CONTROL_UNAUTHORIZED" ? "unauthorized" : "unreachable";
  }

  const value: SelfHostedAvailability = {
    available: reason === "ok",
    reason,
    detail: AVAILABILITY_DETAIL[reason],
    checkedAt: new Date(),
  };
  availabilityCache = {
    value,
    expiresAt: now + (reason === "ok" ? AVAILABLE_TTL_MS : UNAVAILABLE_TTL_MS),
  };
  return value;
}

/** Call after a successful apply so the next availability check reflects reality immediately. Exported for tests. */
export function invalidateSelfHostedAvailability(): void {
  availabilityCache = null;
}
