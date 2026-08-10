import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  validateApplyPayload,
  validateValidatePayload,
  validateReloadPayload,
  validateTestEmailPayload,
} from "../src/validate.js";

/**
 * Cross-reference: these test cases are hand-kept in sync with
 * packages/shared/src/dto/postfix-mail.ts's `updatePostfixConfigSchema`
 * (HOSTNAME_RE / DKIM_SELECTOR_RE / MAIL_LOCALPART_RE / HEADER_UNSAFE_RE
 * and the numeric ranges for destinationRateDelaySeconds /
 * destinationConcurrencyLimit / messageSizeLimitBytes). If either rule set
 * changes, update both files and this table together.
 */

function samplePayload(overrides: Record<string, unknown> = {}) {
  return {
    sendingDomain: "example.com",
    mailHostname: "mail.example.com",
    senderName: "ProjectHub",
    replyToAddress: null,
    dkim: null,
    limits: {
      destinationRateDelaySeconds: 0,
      destinationConcurrencyLimit: 20,
      messageSizeLimitBytes: 10_485_760,
    },
    ...overrides,
  };
}

function generateRsaPrivateKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 1024, // small/fast — only used to exercise the parse check in tests
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return privateKey;
}

describe("validateValidatePayload / validateApplyPayload — shared rules", () => {
  it("accepts a minimal valid payload", () => {
    const result = validateValidatePayload(samplePayload());
    expect(result.ok).toBe(true);
  });

  it("rejects an uppercase / malformed sendingDomain", () => {
    const result = validateValidatePayload(samplePayload({ sendingDomain: "Example.COM" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors["sendingDomain"]).toBeDefined();
  });

  it("rejects an IP-literal mailHostname", () => {
    const result = validateValidatePayload(samplePayload({ mailHostname: "192.168.1.1" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors["mailHostname"]).toBeDefined();
  });

  it("rejects a senderName containing CRLF (header injection attempt)", () => {
    const result = validateValidatePayload(samplePayload({ senderName: "Evil\r\nBcc: attacker@evil.com" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors["senderName"]).toBeDefined();
  });

  it("rejects a senderName containing angle brackets", () => {
    const result = validateValidatePayload(samplePayload({ senderName: "Name<script>" }));
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid replyToAddress", () => {
    const result = validateValidatePayload(samplePayload({ replyToAddress: "not-an-email" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors["replyToAddress"]).toBeDefined();
  });

  it("accepts a valid replyToAddress", () => {
    const result = validateValidatePayload(samplePayload({ replyToAddress: "support@example.com" }));
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown top-level field", () => {
    const result = validateValidatePayload(samplePayload({ extraField: "sneaky" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors["extraField"]).toBe("Unknown field.");
  });

  it("rejects a missing required top-level field", () => {
    const payload = samplePayload();
    delete (payload as Record<string, unknown>)["senderName"];
    const result = validateValidatePayload(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors["senderName"]).toBeDefined();
  });

  it("rejects an unknown nested key under limits", () => {
    const result = validateValidatePayload(samplePayload({ limits: { destinationRateDelaySeconds: 0, destinationConcurrencyLimit: 20, messageSizeLimitBytes: 10_485_760, extra: 1 } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors["limits.extra"]).toBe("Unknown field.");
  });

  it.each([
    ["destinationRateDelaySeconds", -1],
    ["destinationRateDelaySeconds", 3601],
    ["destinationConcurrencyLimit", 0],
    ["destinationConcurrencyLimit", 101],
    ["messageSizeLimitBytes", 1_048_575],
    ["messageSizeLimitBytes", 104_857_601],
  ])("rejects out-of-range limits.%s = %d", (field, value) => {
    const limits = { destinationRateDelaySeconds: 0, destinationConcurrencyLimit: 20, messageSizeLimitBytes: 10_485_760, [field]: value };
    const result = validateValidatePayload(samplePayload({ limits }));
    expect(result.ok).toBe(false);
  });

  it("rejects non-integer (coerced-string) limits — exact-type check, no coercion", () => {
    const result = validateValidatePayload(
      samplePayload({ limits: { destinationRateDelaySeconds: "0", destinationConcurrencyLimit: 20, messageSizeLimitBytes: 10_485_760 } }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer (float) limit", () => {
    const result = validateValidatePayload(
      samplePayload({ limits: { destinationRateDelaySeconds: 1.5, destinationConcurrencyLimit: 20, messageSizeLimitBytes: 10_485_760 } }),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a valid dkim object with enabled:false and no key material", () => {
    const result = validateValidatePayload(samplePayload({ dkim: { enabled: false, selector: "projecthub" } }));
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid dkim.selector", () => {
    const result = validateValidatePayload(samplePayload({ dkim: { enabled: false, selector: "-bad-" } }));
    expect(result.ok).toBe(false);
  });
});

describe("validateValidatePayload — privateKeyPem is REJECTED outright", () => {
  it("422s when privateKeyPem is present, even with a valid key", () => {
    const privateKeyPem = generateRsaPrivateKeyPem();
    const result = validateValidatePayload(samplePayload({ dkim: { enabled: true, selector: "projecthub", privateKeyPem } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors["dkim.privateKeyPem"]).toBeDefined();
  });
});

describe("validateApplyPayload — privateKeyPem REQUIRED when dkim.enabled", () => {
  it("422s when dkim.enabled is true and privateKeyPem is missing", () => {
    const result = validateApplyPayload(samplePayload({ dkim: { enabled: true, selector: "projecthub" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors["dkim.privateKeyPem"]).toBeDefined();
  });

  it("accepts a valid RSA privateKeyPem when dkim.enabled is true", () => {
    const privateKeyPem = generateRsaPrivateKeyPem();
    const result = validateApplyPayload(samplePayload({ dkim: { enabled: true, selector: "projecthub", privateKeyPem } }));
    expect(result.ok).toBe(true);
  });

  it("rejects a non-RSA (EC) key even though it's a syntactically valid private key", () => {
    const { privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const result = validateApplyPayload(samplePayload({ dkim: { enabled: true, selector: "projecthub", privateKeyPem: privateKey } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors["dkim.privateKeyPem"]).toBeDefined();
  });

  it("rejects garbage privateKeyPem text", () => {
    const result = validateApplyPayload(samplePayload({ dkim: { enabled: true, selector: "projecthub", privateKeyPem: "not a real key" } }));
    expect(result.ok).toBe(false);
  });

  it("does not require privateKeyPem when dkim.enabled is false", () => {
    const result = validateApplyPayload(samplePayload({ dkim: { enabled: false, selector: "projecthub" } }));
    expect(result.ok).toBe(true);
  });
});

describe("validateReloadPayload", () => {
  it("accepts an empty object", () => {
    expect(validateReloadPayload({}).ok).toBe(true);
  });

  it("rejects a non-empty object", () => {
    const result = validateReloadPayload({ force: true });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(validateReloadPayload("nope").ok).toBe(false);
    expect(validateReloadPayload(null).ok).toBe(false);
  });
});

describe("validateTestEmailPayload", () => {
  it("accepts a valid recipient", () => {
    const result = validateTestEmailPayload({ recipient: "admin@example.com" });
    expect(result.ok).toBe(true);
  });

  it("rejects a recipient with a header-injection attempt", () => {
    const result = validateTestEmailPayload({ recipient: "admin@example.com>\r\nBcc:attacker@evil.com" });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown field", () => {
    const result = validateTestEmailPayload({ recipient: "admin@example.com", extra: 1 });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing recipient", () => {
    const result = validateTestEmailPayload({});
    expect(result.ok).toBe(false);
  });
});
