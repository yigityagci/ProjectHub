import crypto from "node:crypto";

/**
 * Standalone re-implementation of the wire-payload validation rules for
 * the mail-control listener's 6 fixed operations. Deliberately does NOT
 * import @projecthub/shared (the API's own DTO/zod schemas) — the whole
 * point of this listener re-validating is that it must not trust the
 * caller's validation, including the ProjectHub API's own. Importing the
 * API's schema module here would make "re-validation" a tautology.
 *
 * These rules are hand-kept in sync with (cross-reference, so drift is
 * visible in review): packages/shared/src/dto/postfix-mail.ts —
 * HOSTNAME_RE, DKIM_SELECTOR_RE, MAIL_LOCALPART_RE, HEADER_UNSAFE_RE, and
 * the numeric ranges in updatePostfixConfigSchema. test/validate.test.ts
 * carries a cross-reference table asserting both rule sets agree.
 *
 * On top of duplicating those rules, this module ALSO enforces (things
 * the shared zod schema does not need to, because it already trusts its
 * own process boundary less than this listener trusts ANY caller,
 * including the API):
 *   - strict object shape at EVERY nesting level: any key not on the
 *     fixed allowlist for that level is a 422, so a future API version
 *     can never smuggle an unrecognized field through unnoticed.
 *   - exact-type checks (`typeof v === "number" && Number.isInteger(v)`),
 *     never coercion — "20" is not accepted where 20 is required.
 *   - `dkim.privateKeyPem` must actually parse as an RSA private key
 *     (`crypto.createPrivateKey` + `asymmetricKeyType === "rsa"`) — the
 *     only validation possible on key material, and mandatory before it's
 *     ever written to disk or handed to `opendkim`.
 */

export const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;
export const DKIM_SELECTOR_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const MAIL_LOCALPART_RE = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?$/i;
export const HEADER_UNSAFE_RE = /[\r\n\0<>,;:"\\]/;

export type ValidationOutcome<T> = { ok: true; value: T } | { ok: false; fieldErrors: Record<string, string> };

function ok<T>(value: T): ValidationOutcome<T> {
  return { ok: true, value };
}

function fail<T>(fieldErrors: Record<string, string>): ValidationOutcome<T> {
  return { ok: false, fieldErrors };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isExactInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}

/** Records a "Unknown field." error for every key in `obj` not present in `allowed`. */
function collectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], prefix: string, errors: Record<string, string>): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors[`${prefix}${key}`] = "Unknown field.";
    }
  }
}

function isValidEmailAddress(v: string): boolean {
  if (HEADER_UNSAFE_RE.test(v)) return false;
  const at = v.indexOf("@");
  if (at <= 0 || at !== v.lastIndexOf("@")) return false;
  const localPart = v.slice(0, at);
  const domainPart = v.slice(at + 1);
  return MAIL_LOCALPART_RE.test(localPart) && HOSTNAME_RE.test(domainPart);
}

export interface ValidatedDkim {
  enabled: boolean;
  selector: string;
  privateKeyPem?: string;
}

export interface ValidatedLimits {
  destinationRateDelaySeconds: number;
  destinationConcurrencyLimit: number;
  messageSizeLimitBytes: number;
}

export interface ValidatedConfigPayload {
  sendingDomain: string;
  mailHostname: string;
  senderName: string;
  replyToAddress: string | null;
  dkim: ValidatedDkim | null;
  limits: ValidatedLimits;
}

const TOP_LEVEL_KEYS = ["sendingDomain", "mailHostname", "senderName", "replyToAddress", "dkim", "limits"] as const;
const LIMITS_KEYS = ["destinationRateDelaySeconds", "destinationConcurrencyLimit", "messageSizeLimitBytes"] as const;

interface ValidateConfigOptions {
  /** true for /v1/config/apply, false for /v1/config/validate. */
  allowPrivateKey: boolean;
  /** true for /v1/config/apply when dkim.enabled === true. */
  requirePrivateKeyIfDkimEnabled: boolean;
}

function validateLimits(raw: unknown, errors: Record<string, string>): ValidatedLimits | null {
  if (!isPlainObject(raw)) {
    errors["limits"] = "limits must be an object.";
    return null;
  }
  collectUnknownKeys(raw, LIMITS_KEYS, "limits.", errors);

  const rateDelay = raw["destinationRateDelaySeconds"];
  const concurrency = raw["destinationConcurrencyLimit"];
  const sizeLimit = raw["messageSizeLimitBytes"];

  let hasError = false;
  if (!isExactInteger(rateDelay) || rateDelay < 0 || rateDelay > 3600) {
    errors["limits.destinationRateDelaySeconds"] = "Must be an integer between 0 and 3600.";
    hasError = true;
  }
  if (!isExactInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    errors["limits.destinationConcurrencyLimit"] = "Must be an integer between 1 and 100.";
    hasError = true;
  }
  if (!isExactInteger(sizeLimit) || sizeLimit < 1_048_576 || sizeLimit > 104_857_600) {
    errors["limits.messageSizeLimitBytes"] = "Must be an integer between 1048576 and 104857600.";
    hasError = true;
  }
  if (hasError) return null;

  return {
    destinationRateDelaySeconds: rateDelay as number,
    destinationConcurrencyLimit: concurrency as number,
    messageSizeLimitBytes: sizeLimit as number,
  };
}

function validateDkim(raw: unknown, options: ValidateConfigOptions, errors: Record<string, string>): ValidatedDkim | null | undefined {
  if (raw === null) return null;
  if (!isPlainObject(raw)) {
    errors["dkim"] = "dkim must be null or an object.";
    return undefined;
  }

  const allowedKeys = options.allowPrivateKey ? ["enabled", "selector", "privateKeyPem"] : ["enabled", "selector"];
  collectUnknownKeys(raw, allowedKeys, "dkim.", errors);

  if (!options.allowPrivateKey && "privateKeyPem" in raw) {
    errors["dkim.privateKeyPem"] = "privateKeyPem is not accepted here — validation never needs key material.";
  }

  const enabled = raw["enabled"];
  const selector = raw["selector"];

  let hasError = false;
  if (typeof enabled !== "boolean") {
    errors["dkim.enabled"] = "Must be a boolean.";
    hasError = true;
  }
  if (typeof selector !== "string" || selector.length > 63 || !DKIM_SELECTOR_RE.test(selector)) {
    errors["dkim.selector"] = "Must be a valid DKIM selector.";
    hasError = true;
  }

  let privateKeyPem: string | undefined;
  if (options.allowPrivateKey && "privateKeyPem" in raw) {
    const candidate = raw["privateKeyPem"];
    if (typeof candidate !== "string") {
      errors["dkim.privateKeyPem"] = "Must be a string.";
      hasError = true;
    } else {
      try {
        const keyObject = crypto.createPrivateKey(candidate);
        if (keyObject.asymmetricKeyType !== "rsa") {
          errors["dkim.privateKeyPem"] = "Must be an RSA private key.";
          hasError = true;
        } else {
          privateKeyPem = candidate;
        }
      } catch {
        errors["dkim.privateKeyPem"] = "Must be a valid PKCS8/PEM-encoded private key.";
        hasError = true;
      }
    }
  }

  if (options.allowPrivateKey && options.requirePrivateKeyIfDkimEnabled && enabled === true && privateKeyPem === undefined && !hasError) {
    errors["dkim.privateKeyPem"] = "Required when dkim.enabled is true.";
    hasError = true;
  }

  if (hasError) return undefined;
  return { enabled: enabled as boolean, selector: selector as string, ...(privateKeyPem !== undefined ? { privateKeyPem } : {}) };
}

function validateConfigPayload(body: unknown, options: ValidateConfigOptions): ValidationOutcome<ValidatedConfigPayload> {
  const errors: Record<string, string> = {};

  if (!isPlainObject(body)) {
    return fail({ "": "Request body must be a JSON object." });
  }
  collectUnknownKeys(body, TOP_LEVEL_KEYS, "", errors);

  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in body)) {
      errors[key] = "Required.";
    }
  }

  const sendingDomain = body["sendingDomain"];
  if (typeof sendingDomain !== "string" || sendingDomain.length > 253 || !HOSTNAME_RE.test(sendingDomain)) {
    errors["sendingDomain"] = "Must be a valid domain, e.g. example.com.";
  }

  const mailHostname = body["mailHostname"];
  if (typeof mailHostname !== "string" || mailHostname.length > 253 || !HOSTNAME_RE.test(mailHostname)) {
    errors["mailHostname"] = "Must be a valid hostname, e.g. mail.example.com.";
  }

  const senderName = body["senderName"];
  if (typeof senderName !== "string" || senderName.length < 1 || senderName.length > 120 || HEADER_UNSAFE_RE.test(senderName)) {
    errors["senderName"] = "Must be 1-120 characters with no quotes, angle brackets, or line breaks.";
  }

  const replyToAddressRaw = body["replyToAddress"];
  let replyToAddress: string | null = null;
  if (replyToAddressRaw !== null) {
    if (typeof replyToAddressRaw !== "string" || replyToAddressRaw.length > 254 || !isValidEmailAddress(replyToAddressRaw)) {
      errors["replyToAddress"] = "Must be null or a valid email address.";
    } else {
      replyToAddress = replyToAddressRaw;
    }
  }

  const dkim = "dkim" in body ? validateDkim(body["dkim"], options, errors) : undefined;
  const limits = "limits" in body ? validateLimits(body["limits"], errors) : null;

  if (Object.keys(errors).length > 0) {
    return fail(errors);
  }

  return ok({
    sendingDomain: sendingDomain as string,
    mailHostname: mailHostname as string,
    senderName: senderName as string,
    replyToAddress,
    dkim: dkim ?? null,
    limits: limits as ValidatedLimits,
  });
}

/** /v1/config/apply — privateKeyPem allowed, and REQUIRED when dkim.enabled === true. */
export function validateApplyPayload(body: unknown): ValidationOutcome<ValidatedConfigPayload> {
  return validateConfigPayload(body, { allowPrivateKey: true, requirePrivateKeyIfDkimEnabled: true });
}

/** /v1/config/validate — privateKeyPem REJECTED outright: validation never needs key material. */
export function validateValidatePayload(body: unknown): ValidationOutcome<ValidatedConfigPayload> {
  return validateConfigPayload(body, { allowPrivateKey: false, requirePrivateKeyIfDkimEnabled: false });
}

/** /v1/reload — body must be exactly {}. */
export function validateReloadPayload(body: unknown): ValidationOutcome<Record<string, never>> {
  if (!isPlainObject(body)) {
    return fail({ "": "Request body must be a JSON object." });
  }
  if (Object.keys(body).length > 0) {
    return fail({ "": "The reload operation takes no parameters." });
  }
  return ok({});
}

export interface ValidatedTestEmailPayload {
  recipient: string;
}

/** /v1/test-email — exactly `{ recipient: "<email>" }`. */
export function validateTestEmailPayload(body: unknown): ValidationOutcome<ValidatedTestEmailPayload> {
  const errors: Record<string, string> = {};
  if (!isPlainObject(body)) {
    return fail({ "": "Request body must be a JSON object." });
  }
  collectUnknownKeys(body, ["recipient"], "", errors);

  const recipient = body["recipient"];
  if (typeof recipient !== "string" || recipient.length > 254 || !isValidEmailAddress(recipient)) {
    errors["recipient"] = "Must be a valid email address.";
  }

  if (Object.keys(errors).length > 0) {
    return fail(errors);
  }
  return ok({ recipient: recipient as string });
}
