import http from "node:http";
import { pathToFileURL } from "node:url";
import { isAuthorized, isTokenStrongEnough } from "./auth.js";
import { checkAndConsume, type OpClass } from "./rate-limit.js";
import { tryAcquire, release } from "./mutex.js";
import { MAX_BODY_BYTES, DEFAULT_PORT } from "./config.js";
import {
  validateApplyPayload,
  validateValidatePayload,
  validateReloadPayload,
  validateTestEmailPayload,
} from "./validate.js";
import {
  stageConfigDir,
  generateStagedConfig,
  checkStagedConfig,
  promoteStagedConfig,
  reloadWithRollback,
  readAppliedConfig,
  readPostfixVersion,
  readProcessStatuses,
  checkOutboundSmtp,
  readQueueSummary,
  sendDiagnosticTestEmail,
} from "./postfix.js";
import { writeDkimKeyFiles, checkOpendkimConfig, restartOpendkim } from "./opendkim.js";

/**
 * apps/mail-control/src/index.ts — the hand-rolled HTTP listener that is
 * the most security-sensitive process in the ProjectHub stack. Deliberately
 * plain `node:http`, NOT Fastify/Express: this listener's entire job is to
 * expose exactly 6 fixed, typed operations and reject everything else
 * (raw shell commands, raw Postfix config text, raw parameter names, any
 * unrecognized field/path/method) — a full web framework's routing,
 * middleware, and body-parsing surface is attack surface this process has
 * no use for. See docker-entrypoint.sh / supervisord.conf for how this
 * process is supervised alongside Postfix's own master process in the
 * same container, and README/docker-compose.yml's `mail-control` network
 * comments for the private, unpublished-port network this listens on.
 *
 * Request pipeline, in order, for every one of the 6 real operations:
 *   1. Path+method dispatch — anything not on the fixed table is
 *      `404 UNKNOWN_OPERATION` (checked BEFORE auth, so probing an unknown
 *      path never distinguishes "wrong token" from "no such operation").
 *   2. Auth — `Authorization: Bearer <MAIL_CONTROL_TOKEN>`, constant-time
 *      digest comparison (see auth.ts). Failure is `401 UNAUTHENTICATED`
 *      with no further detail.
 *   3. Content-Type / size enforcement for request bodies (POST ops only).
 *   4. Rate limiting, keyed by `remoteAddress + opClass` (independent of
 *      the ProjectHub API's own limiter — see rate-limit.ts).
 *   5. The single global mutating-op mutex (mutex.ts) for `apply`/
 *      `reload`/`test-email` only.
 *   6. Body parsing + re-validation (validate.ts) + the operation itself.
 *
 * `/healthz` is deliberately NOT a 7th operation — see handleHealthz below.
 */

interface RouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface RouteDef {
  method: string;
  path: string;
  opClass: OpClass;
  mutating: boolean;
  handler: (body: unknown) => Promise<RouteResult>;
}

function isLoopbackAddress(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function getMynetworks(): string {
  return process.env.POSTFIX_MYNETWORKS?.trim() || "127.0.0.0/8 [::1]/128";
}

let lastAppliedDkimEnabled: boolean | null = null;

async function handleApply(body: unknown): Promise<RouteResult> {
  const parsed = validateApplyPayload(body);
  if (!parsed.ok) {
    return {
      status: 422,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid mail configuration.", fieldErrors: parsed.fieldErrors } },
    };
  }
  const payload = parsed.value;

  await stageConfigDir();
  await generateStagedConfig(payload, getMynetworks());

  if (payload.dkim?.enabled) {
    try {
      await writeDkimKeyFiles({ domain: payload.sendingDomain, selector: payload.dkim.selector, privateKeyPem: payload.dkim.privateKeyPem! });
    } catch (err) {
      return {
        status: 422,
        body: {
          error: {
            code: "GENERATED_CONFIG_INVALID",
            message: "Could not write the DKIM key material.",
            details: [err instanceof Error ? err.message : String(err)],
          },
        },
      };
    }
    const dkimCheck = await checkOpendkimConfig();
    if (!dkimCheck.ok) {
      return {
        status: 422,
        body: { error: { code: "GENERATED_CONFIG_INVALID", message: "Generated OpenDKIM configuration is invalid.", details: [dkimCheck.output] } },
      };
    }
  }

  const check = await checkStagedConfig();
  if (!check.ok) {
    return {
      status: 422,
      body: { error: { code: "GENERATED_CONFIG_INVALID", message: "Generated Postfix configuration is invalid.", details: check.errors } },
    };
  }

  await promoteStagedConfig();
  const reload = await reloadWithRollback();
  if (!reload.ok) {
    return {
      status: 500,
      body: { error: { code: "RELOAD_FAILED", message: reload.error ?? "postfix reload failed.", rolledBack: true } },
    };
  }

  const dkimEnabled = payload.dkim?.enabled ?? false;
  if (dkimEnabled !== lastAppliedDkimEnabled) {
    await restartOpendkim().catch(() => undefined); // best-effort — status reporting will still reflect reality on the next poll.
  }
  lastAppliedDkimEnabled = dkimEnabled;

  return {
    status: 200,
    body: {
      ok: true,
      appliedAt: new Date().toISOString(),
      postfixCheck: { ok: true, warnings: check.warnings },
      reload: { ok: true, durationMs: reload.durationMs },
      dkim: { signingEnabled: dkimEnabled, selector: payload.dkim?.selector ?? "" },
    },
  };
}

async function handleValidate(body: unknown): Promise<RouteResult> {
  const parsed = validateValidatePayload(body);
  if (!parsed.ok) {
    return {
      status: 422,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid mail configuration.", fieldErrors: parsed.fieldErrors } },
    };
  }

  await stageConfigDir();
  await generateStagedConfig(parsed.value, getMynetworks());
  const check = await checkStagedConfig();

  return {
    status: 200,
    body: { ok: check.ok, fieldErrors: {}, postfixCheck: { ok: check.ok, warnings: check.warnings } },
  };
}

async function handleReload(body: unknown): Promise<RouteResult> {
  const parsed = validateReloadPayload(body);
  if (!parsed.ok) {
    return { status: 422, body: { error: { code: "VALIDATION_ERROR", message: "The reload operation takes no parameters.", fieldErrors: parsed.fieldErrors } } };
  }
  const result = await reloadWithRollback();
  if (!result.ok) {
    return { status: 500, body: { error: { code: "RELOAD_FAILED", message: result.error ?? "postfix reload failed.", rolledBack: true } } };
  }
  return { status: 200, body: { ok: true, durationMs: result.durationMs } };
}

async function handleStatus(): Promise<RouteResult> {
  const [processes, postfixVersion, appliedConfig, outboundSmtp] = await Promise.all([
    readProcessStatuses(),
    readPostfixVersion(),
    readAppliedConfig(),
    checkOutboundSmtp(),
  ]);

  return {
    status: 200,
    body: {
      ok: true,
      processes,
      postfixVersion,
      appliedConfig: { ...appliedConfig, dkimSigning: lastAppliedDkimEnabled ?? false },
      outboundSmtp,
      checkedAt: new Date().toISOString(),
    },
  };
}

async function handleQueue(): Promise<RouteResult> {
  const summary = await readQueueSummary();
  return {
    status: 200,
    body: {
      ok: true,
      counts: summary.counts,
      oldestArrivalAt: summary.oldestArrivalAt,
      recentErrors: summary.recentErrors,
      truncated: summary.truncated,
      checkedAt: new Date().toISOString(),
    },
  };
}

async function handleTestEmail(body: unknown): Promise<RouteResult> {
  const parsed = validateTestEmailPayload(body);
  if (!parsed.ok) {
    return { status: 422, body: { error: { code: "VALIDATION_ERROR", message: "Invalid recipient address.", fieldErrors: parsed.fieldErrors } } };
  }

  const applied = await readAppliedConfig();
  const domain = applied.mydomain;
  if (!domain) {
    return { status: 409, body: { error: { code: "NOT_CONFIGURED", message: "Postfix has not been configured yet — apply a mail configuration first." } } };
  }

  try {
    const { sender, queueId } = await sendDiagnosticTestEmail(parsed.value.recipient, domain);
    return { status: 200, body: { ok: true, queueId, accepted: true, sender } };
  } catch (err) {
    return { status: 500, body: { error: { code: "SEND_FAILED", message: err instanceof Error ? err.message : "Failed to send the test email." } } };
  }
}

const ROUTES: RouteDef[] = [
  { method: "POST", path: "/v1/config/apply", opClass: "mutating", mutating: true, handler: handleApply },
  { method: "POST", path: "/v1/config/validate", opClass: "read", mutating: false, handler: handleValidate },
  { method: "POST", path: "/v1/reload", opClass: "mutating", mutating: true, handler: handleReload },
  { method: "GET", path: "/v1/status", opClass: "read", mutating: false, handler: handleStatus },
  { method: "GET", path: "/v1/queue", opClass: "read", mutating: false, handler: handleQueue },
  { method: "POST", path: "/v1/test-email", opClass: "mutating", mutating: true, handler: handleTestEmail },
];

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  onSent?: () => void,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    ...headers,
  });
  res.end(json, onSent);
}

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

/**
 * Reads and JSON-parses a request body, enforcing MAX_BODY_BYTES BOTH up
 * front (caller checks Content-Length before calling this) AND mid-stream
 * here (a lying or absent Content-Length header must not bypass the cap —
 * this accumulates actual bytes received and aborts the instant the real
 * total exceeds the limit). Deliberately does NOT destroy the socket the
 * instant the cap is exceeded: destroying `req` destroys the underlying
 * TCP socket for BOTH directions, which would make it impossible to ever
 * send the 413 response body back. Instead this rejects with
 * BodyTooLargeError so the caller (handleRequest) can send a proper 413
 * response first, and only THEN destroy the connection (via the
 * `onSent`/close callback) to stop the client from pushing any more of an
 * oversized payload.
 */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        reject(new BodyTooLargeError("Request body exceeds the maximum allowed size."));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new InvalidJsonError("Request body is not valid JSON."));
      }
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function handleHealthz(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Deliberately NOT a 7th operation — the fixed 6-op set stays closed.
  // Only reachable "successfully" from loopback (the Docker HEALTHCHECK
  // runs inside this same container); from anywhere else on the private
  // control-plane network (i.e. the `api` container) it is
  // indistinguishable from any other unknown path.
  const remoteAddress = req.socket.remoteAddress;
  if (isLoopbackAddress(remoteAddress)) {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  sendJson(res, 404, { error: { code: "UNKNOWN_OPERATION", message: "Unknown mail-control operation." } });
}

export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://mail-control.internal");
  const pathname = url.pathname; // query strings ignored entirely — no route has a path parameter either, by construction.

  if (method === "GET" && pathname === "/healthz") {
    handleHealthz(req, res);
    return;
  }

  const route = ROUTES.find((r) => r.method === method && r.path === pathname);
  if (!route) {
    sendJson(res, 404, { error: { code: "UNKNOWN_OPERATION", message: "Unknown mail-control operation." } });
    return;
  }

  const token = process.env.MAIL_CONTROL_TOKEN ?? "";
  if (!isAuthorized(req.headers.authorization, token)) {
    sendJson(res, 401, { error: { code: "UNAUTHENTICATED", message: "Invalid service credential." } });
    return;
  }

  if (method === "POST") {
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      sendJson(res, 415, { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json." } });
      return;
    }

    const contentLengthHeader = req.headers["content-length"];
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_BODY_BYTES) {
      sendJson(
        res,
        413,
        { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the maximum allowed size." } },
        { Connection: "close" },
        () => req.destroy(),
      );
      return;
    }
  }

  const remoteAddress = req.socket.remoteAddress ?? "unknown";
  const rateLimitResult = checkAndConsume(remoteAddress, route.opClass);
  if (!rateLimitResult.allowed) {
    sendJson(
      res,
      429,
      { error: { code: "RATE_LIMITED", message: "Too many requests.", retryAfterSeconds: rateLimitResult.retryAfterSeconds } },
      { "Retry-After": String(rateLimitResult.retryAfterSeconds ?? 60) },
    );
    return;
  }

  let acquiredMutex = false;
  if (route.mutating) {
    acquiredMutex = tryAcquire();
    if (!acquiredMutex) {
      sendJson(res, 409, { error: { code: "OPERATION_IN_PROGRESS", message: "Another mail-control operation is already in progress." } });
      return;
    }
  }

  try {
    const body = method === "POST" ? await readJsonBody(req) : {};
    const result = await route.handler(body);
    sendJson(res, result.status, result.body, result.headers);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // Respond FIRST, then destroy the connection once the response has
      // been handed to the socket — never the other way around, or the
      // 413 body could never reach the client (see readJsonBody's doc
      // comment). Destroying afterward stops the client from continuing
      // to push an oversized payload into an already-answered request.
      sendJson(res, 413, { error: { code: "PAYLOAD_TOO_LARGE", message: err.message } }, {}, () => req.destroy());
    } else if (err instanceof InvalidJsonError) {
      sendJson(res, 422, { error: { code: "VALIDATION_ERROR", message: err.message } });
    } else {
      sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Unexpected error." } });
    }
  } finally {
    if (acquiredMutex) release();
  }
}

export function createServer(): http.Server {
  return http.createServer((req, res) => {
    void handleRequest(req, res);
  });
}

function main(): void {
  const token = process.env.MAIL_CONTROL_TOKEN;
  if (!isTokenStrongEnough(token)) {
    // eslint-disable-next-line no-console
    console.error("MAIL_CONTROL_TOKEN is missing or shorter than 32 characters. Refusing to start.");
    process.exit(1);
  }

  const port = process.env.MAIL_CONTROL_PORT ? Number(process.env.MAIL_CONTROL_PORT) : DEFAULT_PORT;
  const server = createServer();
  server.listen(port, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`mail-control listening on 0.0.0.0:${port}`);
  });
}

const isEntryPoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main();
}
