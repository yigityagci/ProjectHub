import crypto from "node:crypto";
import fs from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { EXEC_TIMEOUT_MS, EXEC_MAX_BUFFER_BYTES, SAFE_EXEC_PATH } from "./config.js";

const execFile = promisify(execFileCb);

const OPENDKIM_KEYS_DIR = "/etc/opendkim/keys";
const OPENDKIM_KEY_TABLE = "/etc/opendkim/KeyTable";
const OPENDKIM_SIGNING_TABLE = "/etc/opendkim/SigningTable";
const OPENDKIM_TRUSTED_HOSTS = "/etc/opendkim/TrustedHosts";
const OPENDKIM_CONF = "/etc/opendkim.conf";

// Domain/selector are already validated by validate.ts several layers up
// (HOSTNAME_RE / DKIM_SELECTOR_RE), but this module re-asserts the exact
// same shape immediately before it joins them into a filesystem path or a
// config-file line — "assume nothing survived the trip", not "trust the
// caller three layers up validated it".
const SAFE_DOMAIN_OR_SELECTOR_RE = /^[a-z0-9.-]+$/;

function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_DOMAIN_OR_SELECTOR_RE.test(value)) {
    throw new Error(`Refusing to use unsafe ${label} value in a filesystem path or DKIM config line.`);
  }
}

/**
 * Validates that `privateKeyPem` actually parses as an RSA private key.
 * This is the only validation possible on key material (see validate.ts,
 * which performs the identical check before this is ever called from
 * /v1/config/apply) — re-checked here too since this function is the last
 * line of defense before anything touches disk.
 */
export function assertRsaPrivateKey(privateKeyPem: string): void {
  const keyObject = crypto.createPrivateKey(privateKeyPem);
  if (keyObject.asymmetricKeyType !== "rsa") {
    throw new Error("DKIM private key must be an RSA key.");
  }
}

export interface WriteDkimKeyFilesInput {
  domain: string;
  selector: string;
  privateKeyPem: string;
}

/**
 * Writes the DKIM private key + regenerates KeyTable/SigningTable/
 * TrustedHosts from validated values only.
 *
 * DELIBERATE DEVIATION from a literal "chowned to the opendkim user"
 * implementation, documented here: this process runs as the unprivileged
 * `mailctl` user (see Dockerfile), which cannot `chown` a file to a
 * DIFFERENT user (that requires root/CAP_CHOWN) without widening the
 * sudoers allowlist beyond the three EXACT entries this design
 * deliberately keeps narrow (postfix check/reload, postconf — see
 * postfix.ts#runPrivileged's doc comment). Instead, this achieves the
 * IDENTICAL confidentiality property (only `mailctl` and `opendkim` can
 * ever read the private key; nobody else) via Unix group permissions
 * set up at image build time: `/etc/opendkim/keys` is group-owned by
 * `opendkim` with the setgid bit, and `mailctl` is a supplementary
 * member of the `opendkim` group. The key file is written mode 0640
 * (owner `mailctl`: read/write, group `opendkim`: read-only, others:
 * none) rather than 0600-owned-by-opendkim — a different mechanism for
 * the same guarantee, not a weaker one.
 */
export async function writeDkimKeyFiles(input: WriteDkimKeyFilesInput): Promise<void> {
  assertSafeSegment(input.domain, "domain");
  assertSafeSegment(input.selector, "selector");
  assertRsaPrivateKey(input.privateKeyPem);

  const domainDir = `${OPENDKIM_KEYS_DIR}/${input.domain}`;
  const keyPath = `${domainDir}/${input.selector}.private`;

  await fs.mkdir(domainDir, { recursive: true, mode: 0o750 });
  await fs.writeFile(keyPath, input.privateKeyPem, { mode: 0o640 });

  await fs.writeFile(OPENDKIM_KEY_TABLE, `${input.selector}._domainkey.${input.domain} ${input.domain}:${input.selector}:${keyPath}\n`, "utf8");
  await fs.writeFile(OPENDKIM_SIGNING_TABLE, `*@${input.domain} ${input.selector}._domainkey.${input.domain}\n`, "utf8");
  await fs.writeFile(OPENDKIM_TRUSTED_HOSTS, ["127.0.0.1", "localhost", input.domain].join("\n") + "\n", "utf8");
}

export interface DkimCheckResult {
  ok: boolean;
  output: string;
}

/** `opendkim -n -x <conf>` test-parses the config WITHOUT starting the daemon. */
export async function checkOpendkimConfig(): Promise<DkimCheckResult> {
  try {
    const { stdout, stderr } = await execFile("/usr/sbin/opendkim", ["-n", "-x", OPENDKIM_CONF], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER_BYTES,
      env: { PATH: SAFE_EXEC_PATH },
    });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: message };
  }
}

export async function restartOpendkim(): Promise<void> {
  await execFile("/usr/bin/supervisorctl", ["restart", "opendkim"], {
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: EXEC_MAX_BUFFER_BYTES,
    env: { PATH: SAFE_EXEC_PATH },
  });
}
