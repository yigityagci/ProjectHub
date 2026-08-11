import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { EXEC_TIMEOUT_MS, EXEC_MAX_BUFFER_BYTES, SAFE_EXEC_PATH, OUTBOUND_SMTP_PROBE_TARGETS, OUTBOUND_SMTP_PROBE_TIMEOUT_MS, OUTBOUND_SMTP_PROBE_CACHE_MS, QUEUE_CACHE_MS, QUEUE_MAX_ENTRIES, QUEUE_MAX_RECENT_ERRORS } from "./config.js";
import type { ValidatedConfigPayload } from "./validate.js";

const execFile = promisify(execFileCb);

/**
 * Every external process this listener ever invokes goes through
 * `runCommand` below: ALWAYS `execFile` with an argv array, NEVER `exec`/a
 * shell string/`shell: true`. This is the single chokepoint that makes
 * "no code path accepts a raw shell command" an invariant rather than a
 * convention — there is exactly one place a shell could be introduced, and
 * it deliberately isn't one.
 */
async function runCommand(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFile(bin, args, {
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: EXEC_MAX_BUFFER_BYTES,
    env: { PATH: SAFE_EXEC_PATH },
  });
}

/**
 * SECURITY-LOAD-BEARING: the mail-control listener runs as the
 * unprivileged `mailctl` user (see Dockerfile / supervisord.conf), not
 * root. Reloading/checking Postfix and writing `postconf` output both
 * require root (Postfix's own config directory and its running master
 * process are root-owned by the distro package). Rather than run this
 * whole process as root, `mailctl` has a narrow, build-time `sudoers.d`
 * NOPASSWD allowlist for EXACTLY three invocations: `postfix -c
 * /etc/postfix.staging check`, `postfix reload`, and `postconf` (with
 * any arguments — postconf itself never accepts a raw parameter NAME
 * from any caller; see buildPostconfArgs's hardcoded field->parameter
 * map, which is the actual security boundary here, not this sudo rule).
 * This is the ONLY escalation path in this process, and it is scoped to
 * these exact binaries/argument shapes, never a general shell.
 */
async function runPrivileged(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return runCommand("/usr/bin/sudo", ["-n", bin, ...args]);
}

const STAGING_DIR = "/etc/postfix.staging";
const LIVE_DIR = "/etc/postfix";
const MAIN_CF = `${LIVE_DIR}/main.cf`;
const MAIN_CF_BACKUP = `${LIVE_DIR}/main.cf.bak`;
const STAGING_MAIN_CF = `${STAGING_DIR}/main.cf`;

/**
 * Step 1 (see class-level pipeline doc in index.ts): copy /etc/postfix ->
 * a fresh staging directory. Clears the staging directory's CONTENTS,
 * never removes the directory node itself: /etc/postfix.staging is
 * pre-created at image build time with group=postfix + setgid (see
 * Dockerfile) so the unprivileged `mailctl` user can write there without
 * sudo — `rm`-ing the node itself would require write access to `/etc`
 * (root-owned, mode 755) to recreate it, throwing EACCES. No shell
 * globbing/rm -rf string — fs.promises APIs only.
 */
export async function stageConfigDir(): Promise<void> {
  const entries = await fs.readdir(STAGING_DIR);
  await Promise.all(entries.map((entry) => fs.rm(path.join(STAGING_DIR, entry), { recursive: true, force: true })));
  await fs.cp(LIVE_DIR, STAGING_DIR, { recursive: true });
}

/**
 * The ONLY place a caller's typed field maps to a Postfix parameter name.
 * A caller NEVER names a parameter directly — this map is hardcoded here,
 * so there is no path for any caller (including the ProjectHub API) to
 * set an arbitrary `postconf` key. Pure function: returns the exact
 * `postconf` argv list to run, without running anything — this is the
 * "config-generation-from-template" logic, independently unit-tested (see
 * test/postfix.test.ts) without needing a real Postfix installation.
 */
export function buildPostconfArgs(payload: ValidatedConfigPayload, mynetworks: string): string[][] {
  const set = (param: string, value: string): string[] => ["-c", STAGING_DIR, "-e", `${param}=${value}`];

  const dkimEnabled = payload.dkim?.enabled === true;
  const milters = dkimEnabled ? "inet:127.0.0.1:8891" : "";

  return [
    set("myhostname", payload.mailHostname),
    set("mydomain", payload.sendingDomain),
    set("myorigin", "$mydomain"),
    set("smtp_helo_name", "$myhostname"),
    // Send-only MTA: accepts no local delivery.
    set("mydestination", ""),
    set("mynetworks", mynetworks),
    set("message_size_limit", String(payload.limits.messageSizeLimitBytes)),
    set("smtp_destination_rate_delay", `${payload.limits.destinationRateDelaySeconds}s`),
    set("smtp_destination_concurrency_limit", String(payload.limits.destinationConcurrencyLimit)),
    set("smtpd_milters", milters),
    set("non_smtpd_milters", milters),
  ];
}

export async function generateStagedConfig(payload: ValidatedConfigPayload, mynetworks: string): Promise<void> {
  const argvList = buildPostconfArgs(payload, mynetworks);
  for (const args of argvList) {
    await runPrivileged("/usr/sbin/postconf", args);
  }
}

export interface PostfixCheckResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
}

/** Parses `postfix check`'s stdout+stderr lines into warnings/errors. Pure function — unit-tested independent of a real Postfix binary. */
export function parsePostfixCheckOutput(combinedOutput: string): PostfixCheckResult {
  const lines = combinedOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const errors = lines.filter((l) => /\b(fatal|error):/i.test(l));
  const warnings = lines.filter((l) => /\bwarning:/i.test(l));
  return { ok: errors.length === 0, warnings, errors };
}

/** Step 4: validate the STAGED config only — nothing is promoted/reloaded if this fails. */
export async function checkStagedConfig(): Promise<PostfixCheckResult> {
  try {
    const { stdout, stderr } = await runPrivileged("/usr/sbin/postfix", ["-c", STAGING_DIR, "check"]);
    return parsePostfixCheckOutput(`${stdout}\n${stderr}`);
  } catch (err) {
    const combined = err instanceof Error && "stdout" in err ? String((err as { stdout?: string }).stdout ?? "") + String((err as { stderr?: string }).stderr ?? "") : String(err);
    const parsed = parsePostfixCheckOutput(combined);
    return { ok: false, warnings: parsed.warnings, errors: parsed.errors.length > 0 ? parsed.errors : [combined || "postfix check failed"] };
  }
}

/** Step 5: promote staged main.cf to live, keeping a single-generation backup for rollback. */
export async function promoteStagedConfig(): Promise<void> {
  await fs.copyFile(MAIN_CF, MAIN_CF_BACKUP).catch(() => undefined);
  await fs.copyFile(STAGING_MAIN_CF, MAIN_CF);
}

export interface ReloadOutcome {
  ok: boolean;
  durationMs: number;
  rolledBack: boolean;
  error?: string;
}

/** Step 6: reload; on failure, restore the previous main.cf and reload again. */
export async function reloadWithRollback(): Promise<ReloadOutcome> {
  const start = Date.now();
  try {
    await runPrivileged("/usr/sbin/postfix", ["reload"]);
    return { ok: true, durationMs: Date.now() - start, rolledBack: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : "postfix reload failed";
    try {
      await fs.copyFile(MAIN_CF_BACKUP, MAIN_CF);
      await runPrivileged("/usr/sbin/postfix", ["reload"]);
    } catch {
      // best-effort rollback; the outer caller surfaces RELOAD_FAILED regardless.
    }
    return { ok: false, durationMs: Date.now() - start, rolledBack: true, error: message };
  }
}

const APPLIED_CONFIG_KEYS = [
  ["myhostname", "myhostname"],
  ["mydomain", "mydomain"],
  ["message_size_limit", "messageSizeLimit"],
  ["smtp_destination_rate_delay", "smtpDestinationRateDelay"],
  ["smtp_destination_concurrency_limit", "smtpDestinationConcurrencyLimit"],
] as const;

/** `postconf -n -h <key>` for EXACTLY the named keys above — never a full `postconf -n` dump. */
export async function readAppliedConfig(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [param, label] of APPLIED_CONFIG_KEYS) {
    try {
      const { stdout } = await runPrivileged("/usr/sbin/postconf", ["-h", param]);
      result[label] = stdout.trim();
    } catch {
      result[label] = "";
    }
  }
  return result;
}

export async function readPostfixVersion(): Promise<string | null> {
  try {
    const { stdout } = await runPrivileged("/usr/sbin/postconf", ["-h", "mail_version"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Parses `supervisorctl status` output (e.g. "postfix RUNNING pid 12, uptime 0:01:02") into { name: STATE }. Pure — unit-tested. */
export function parseSupervisorStatus(output: string): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\S+)\s+(\S+)/);
    if (match) {
      const [, name, state] = match;
      if (name && state) statuses[name] = state;
    }
  }
  return statuses;
}

export async function readProcessStatuses(): Promise<Record<string, string>> {
  try {
    const { stdout } = await runCommand("/usr/bin/supervisorctl", ["status"]);
    return parseSupervisorStatus(stdout);
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String((err as { stdout?: string }).stdout ?? "") : "";
    return parseSupervisorStatus(stdout);
  }
}

let outboundProbeCache: { value: OutboundSmtpProbeResult; expiresAt: number } | null = null;

export interface OutboundSmtpProbeResult {
  checked: boolean;
  reachable: boolean;
  target: string | null;
  latencyMs: number | null;
  error: string | null;
  bestEffort: true;
  checkedAt: string;
}

function probeOneTarget(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.connect({ host, port, timeout: timeoutMs });
    const finish = (result: number | null) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(Date.now() - start));
    socket.once("timeout", () => finish(null));
    socket.once("error", () => finish(null));
  });
}

/**
 * Best-effort outbound-port-25 reachability check FROM the Postfix
 * container (its egress, not the API's, is what determines
 * deliverability). `bestEffort: true` is literal — a `false` result is a
 * warning surfaced to the admin, never treated as a hard verdict (many
 * networks/hosts legitimately block outbound 25 from *this* probe path
 * while still delivering mail fine via the target MX's actual policies).
 *
 * Targets are probed in PARALLEL, not sequentially: this is a "try until
 * one succeeds" check, so the worst case (every target unreachable) must
 * stay bounded by a single OUTBOUND_SMTP_PROBE_TIMEOUT_MS regardless of
 * how many targets exist. A sequential for-loop here previously made the
 * worst case `targets.length * OUTBOUND_SMTP_PROBE_TIMEOUT_MS` (10s for
 * today's 2 targets) -- confirmed live against a real self-hosted stack
 * with no outbound port-25 route, where this endpoint is embedded in
 * /v1/status and consistently exceeded the API client's read timeout,
 * making a perfectly healthy Postfix+listener permanently report as
 * "unreachable" in the admin settings UI.
 */
export async function checkOutboundSmtp(now = Date.now()): Promise<OutboundSmtpProbeResult> {
  if (outboundProbeCache && outboundProbeCache.expiresAt > now) {
    return outboundProbeCache.value;
  }

  const attempts = await Promise.all(
    OUTBOUND_SMTP_PROBE_TARGETS.map(async (target) => ({
      ...target,
      latencyMs: await probeOneTarget(target.host, target.port, OUTBOUND_SMTP_PROBE_TIMEOUT_MS),
    })),
  );
  const reached = attempts.find((attempt) => attempt.latencyMs !== null);

  const value: OutboundSmtpProbeResult = reached
    ? {
        checked: true,
        reachable: true,
        target: `${reached.host}:${reached.port}`,
        latencyMs: reached.latencyMs,
        error: null,
        bestEffort: true,
        checkedAt: new Date(now).toISOString(),
      }
    : {
        checked: true,
        reachable: false,
        target: null,
        latencyMs: null,
        error: "Could not reach any outbound SMTP probe target on port 25.",
        bestEffort: true,
        checkedAt: new Date(now).toISOString(),
      };
  outboundProbeCache = { value, expiresAt: now + OUTBOUND_SMTP_PROBE_CACHE_MS };
  return value;
}

export interface QueueEntry {
  queue_id?: string;
  arrival_time?: number;
  message_size?: number;
  sender?: string;
  recipients?: Array<{ address?: string; delay_reason?: string }>;
  queue_name?: string;
}

export interface QueueSummary {
  counts: Record<string, number>;
  oldestArrivalAt: string | null;
  recentErrors: Array<{ queueId: string; arrivalAt: string; recipient: string; reason: string }>;
  truncated: boolean;
}

/** Parses `postqueue -j` NDJSON output. Pure — unit-tested without a real mail queue. */
export function parseQueueOutput(ndjson: string): QueueSummary {
  const lines = ndjson
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const truncated = lines.length > QUEUE_MAX_ENTRIES;
  const entries: QueueEntry[] = [];
  for (const line of lines.slice(0, QUEUE_MAX_ENTRIES)) {
    try {
      entries.push(JSON.parse(line) as QueueEntry);
    } catch {
      // skip unparseable lines rather than failing the whole summary
    }
  }

  const counts: Record<string, number> = { total: 0, active: 0, deferred: 0, hold: 0, incoming: 0, maildrop: 0 };
  let oldestArrivalMs: number | null = null;
  const recentErrors: QueueSummary["recentErrors"] = [];

  for (const entry of entries) {
    counts.total = (counts.total ?? 0) + 1;
    const queueName = entry.queue_name;
    if (queueName && queueName in counts) {
      counts[queueName] = (counts[queueName] ?? 0) + 1;
    }
    if (typeof entry.arrival_time === "number") {
      const ms = entry.arrival_time * 1000;
      if (oldestArrivalMs === null || ms < oldestArrivalMs) oldestArrivalMs = ms;
    }
    if (recentErrors.length < QUEUE_MAX_RECENT_ERRORS) {
      for (const recipient of entry.recipients ?? []) {
        if (recipient.delay_reason) {
          recentErrors.push({
            queueId: entry.queue_id ?? "unknown",
            arrivalAt: typeof entry.arrival_time === "number" ? new Date(entry.arrival_time * 1000).toISOString() : new Date(0).toISOString(),
            recipient: recipient.address ?? "unknown",
            reason: recipient.delay_reason,
          });
          if (recentErrors.length >= QUEUE_MAX_RECENT_ERRORS) break;
        }
      }
    }
  }

  return {
    counts,
    oldestArrivalAt: oldestArrivalMs !== null ? new Date(oldestArrivalMs).toISOString() : null,
    recentErrors,
    truncated,
  };
}

let queueCache: { value: QueueSummary; expiresAt: number } | null = null;

export async function readQueueSummary(now = Date.now()): Promise<QueueSummary> {
  if (queueCache && queueCache.expiresAt > now) {
    return queueCache.value;
  }
  const { stdout } = await runCommand("/usr/sbin/postqueue", ["-j"]);
  const summary = parseQueueOutput(stdout);
  queueCache = { value: summary, expiresAt: now + QUEUE_CACHE_MS };
  return summary;
}

/**
 * Sends a fixed, hardcoded diagnostic message via `sendmail`. The ONLY
 * caller-supplied byte sequence is `recipient` (already regex-validated
 * by validate.ts before this is ever called) — subject/body/sender are
 * all fixed/derived, never caller-controlled, so there is no header-
 * injection surface here.
 */
export async function sendDiagnosticTestEmail(recipient: string, senderDomain: string): Promise<{ sender: string; queueId: string | null }> {
  const sender = `no-reply@${senderDomain}`;
  const message = [
    `From: ${sender}`,
    `To: ${recipient}`,
    "Subject: ProjectHub self-hosted mail delivery test",
    "",
    "This is a diagnostic test email sent by the ProjectHub mail-control listener to verify self-hosted Postfix delivery is working.",
    "",
  ].join("\r\n");

  // `sendmail` reads the RFC5322 message from stdin — execFile has no
  // stdin-piping option for the async/promisified form, so this uses
  // `spawn` directly (still argv-array, never a shell string) and writes
  // to the child's stdin explicitly.
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/sbin/sendmail", ["-f", sender, "-i", "--", recipient], {
      timeout: EXEC_TIMEOUT_MS,
      env: { PATH: SAFE_EXEC_PATH },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sendmail exited with code ${code}: ${stderr.trim()}`));
    });
    child.stdin?.end(message);
  });

  let queueId: string | null = null;
  try {
    const { stdout } = await runCommand("/usr/sbin/postqueue", ["-j"]);
    const lastLine = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .find((line) => line.includes(recipient));
    if (lastLine) {
      const parsed = JSON.parse(lastLine) as QueueEntry;
      queueId = parsed.queue_id ?? null;
    }
  } catch {
    queueId = null;
  }

  return { sender, queueId };
}
