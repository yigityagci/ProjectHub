import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  completeSetup,
  registerAndLogin,
  freshClient,
  type TestClient,
} from "./helpers.js";
import { prisma } from "../src/core/prisma.js";
import { env } from "../src/config/env.js";
import { invalidateSelfHostedAvailability } from "../src/email/mail-control.client.js";
import { generateDkimKeySchema } from "@projecthub/shared";

/**
 * Self-hosted Postfix mail delivery: /api/platform/mail-delivery and every
 * /api/platform/postfix-config* route. The test environment never sets
 * MAIL_CONTROL_URL/MAIL_CONTROL_TOKEN (see test/setup.ts), so
 * getSelfHostedAvailability() short-circuits to `not_configured` with zero
 * network I/O for most of this file — a handful of tests near the bottom
 * temporarily mutate the shared `env` singleton to exercise the
 * reachability-gate ("unreachable") path against a real (refused) TCP
 * connection, then restore it.
 */
describe("Self-hosted Postfix mail delivery (/api/platform/mail-delivery, /api/platform/postfix-config*)", () => {
  let app: FastifyInstance;
  let admin: TestClient;
  let nonAdmin: TestClient;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    const setup = await completeSetup(app, "postfix-admin@example.com");
    admin = setup.client;
    nonAdmin = await registerAndLogin(app, "postfix-plain-member@example.com");
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  function validPatchBody(overrides: Record<string, unknown> = {}) {
    return {
      enabled: false,
      sendingDomain: "example.com",
      mailHostname: "mail.example.com",
      senderName: "ProjectHub",
      destinationRateDelaySeconds: 0,
      destinationConcurrencyLimit: 20,
      messageSizeLimitBytes: 10_485_760,
      ...overrides,
    };
  }

  describe("401/403 matrix", () => {
    it("unauthenticated callers get 401 on every route", async () => {
      const anon = freshClient(app);
      expect((await anon.get("/api/platform/mail-delivery")).statusCode).toBe(401);
      expect((await anon.patch("/api/platform/postfix-config", validPatchBody())).statusCode).toBe(401);
      expect((await anon.post("/api/platform/postfix-config/apply")).statusCode).toBe(401);
      expect((await anon.post("/api/platform/postfix-config/validate", validPatchBody())).statusCode).toBe(401);
      expect((await anon.post("/api/platform/postfix-config/dkim-key", { keyBits: 2048 })).statusCode).toBe(401);
      expect((await anon.get("/api/platform/postfix-config/status")).statusCode).toBe(401);
      expect((await anon.get("/api/platform/postfix-config/queue")).statusCode).toBe(401);
      expect((await anon.post("/api/platform/postfix-config/test-email")).statusCode).toBe(401);
      expect((await anon.get("/api/platform/postfix-config/dns-check")).statusCode).toBe(401);
      expect((await anon.delete("/api/platform/postfix-config")).statusCode).toBe(401);
    });

    it("a non-platform-admin gets 403 on every route", async () => {
      expect((await nonAdmin.get("/api/platform/mail-delivery")).statusCode).toBe(403);
      expect((await nonAdmin.patch("/api/platform/postfix-config", validPatchBody())).statusCode).toBe(403);
      expect((await nonAdmin.post("/api/platform/postfix-config/apply")).statusCode).toBe(403);
      expect((await nonAdmin.post("/api/platform/postfix-config/validate", validPatchBody())).statusCode).toBe(403);
      expect((await nonAdmin.post("/api/platform/postfix-config/dkim-key", { keyBits: 2048 })).statusCode).toBe(403);
      expect((await nonAdmin.get("/api/platform/postfix-config/status")).statusCode).toBe(403);
      expect((await nonAdmin.get("/api/platform/postfix-config/queue")).statusCode).toBe(403);
      expect((await nonAdmin.post("/api/platform/postfix-config/test-email")).statusCode).toBe(403);
      expect((await nonAdmin.get("/api/platform/postfix-config/dns-check")).statusCode).toBe(403);
      expect((await nonAdmin.delete("/api/platform/postfix-config")).statusCode).toBe(403);
    });
  });

  describe("GET /api/platform/mail-delivery", () => {
    it("reports mode: smtp and postfix: null before anything has been saved, self-hosted unavailable (not_configured)", async () => {
      const res = await admin.get("/api/platform/mail-delivery");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.mode).toBe("smtp");
      expect(body.postfix).toBeNull();
      expect(body.selfHosted.available).toBe(false);
      expect(body.selfHosted.reason).toBe("not_configured");
    });
  });

  describe("PATCH /api/platform/postfix-config — validation", () => {
    it("strict schema rejects mass-assignment of an unrecognized field", async () => {
      const res = await admin.patch("/api/platform/postfix-config", validPatchBody({ notAField: "x" }));
      expect(res.statusCode).toBe(422);
    });

    it("rejects a senderName containing CRLF (header-injection defense)", async () => {
      const res = await admin.patch(
        "/api/platform/postfix-config",
        validPatchBody({ senderName: "Evil\r\nBcc: attacker@example.com" }),
      );
      expect(res.statusCode).toBe(422);
    });

    it("rejects a senderName containing an angle bracket", async () => {
      const res = await admin.patch("/api/platform/postfix-config", validPatchBody({ senderName: "Evil <x>" }));
      expect(res.statusCode).toBe(422);
    });

    it("rejects an invalid sendingDomain", async () => {
      const res = await admin.patch("/api/platform/postfix-config", validPatchBody({ sendingDomain: "not a domain" }));
      expect(res.statusCode).toBe(422);
    });

    it("rejects destinationRateDelaySeconds outside 0-3600", async () => {
      const tooLow = await admin.patch("/api/platform/postfix-config", validPatchBody({ destinationRateDelaySeconds: -1 }));
      expect(tooLow.statusCode).toBe(422);
      const tooHigh = await admin.patch("/api/platform/postfix-config", validPatchBody({ destinationRateDelaySeconds: 3601 }));
      expect(tooHigh.statusCode).toBe(422);
    });

    it("rejects destinationConcurrencyLimit outside 1-100", async () => {
      const tooLow = await admin.patch("/api/platform/postfix-config", validPatchBody({ destinationConcurrencyLimit: 0 }));
      expect(tooLow.statusCode).toBe(422);
      const tooHigh = await admin.patch("/api/platform/postfix-config", validPatchBody({ destinationConcurrencyLimit: 101 }));
      expect(tooHigh.statusCode).toBe(422);
    });

    it("rejects messageSizeLimitBytes outside 1048576-104857600", async () => {
      const tooLow = await admin.patch("/api/platform/postfix-config", validPatchBody({ messageSizeLimitBytes: 1_048_575 }));
      expect(tooLow.statusCode).toBe(422);
      const tooHigh = await admin.patch("/api/platform/postfix-config", validPatchBody({ messageSizeLimitBytes: 104_857_601 }));
      expect(tooHigh.statusCode).toBe(422);
    });

    it("rejects a non-integer destinationConcurrencyLimit", async () => {
      const res = await admin.patch("/api/platform/postfix-config", validPatchBody({ destinationConcurrencyLimit: 20.5 }));
      expect(res.statusCode).toBe(422);
    });
  });

  describe("PATCH /api/platform/postfix-config — enabled while self-hosted is unavailable", () => {
    it("enabled: true is rejected with 503 SELF_HOSTED_UNAVAILABLE when MAIL_CONTROL_URL/TOKEN are unset", async () => {
      const res = await admin.patch("/api/platform/postfix-config", validPatchBody({ enabled: true }));
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("SELF_HOSTED_UNAVAILABLE");

      // Nothing was persisted as a side effect of the rejected attempt.
      const row = await prisma.platformPostfixConfig.findUnique({ where: { id: "singleton" } });
      expect(row).toBeNull();
    });
  });

  describe("PATCH /api/platform/postfix-config — happy path (enabled: false, no listener needed)", () => {
    it("saves the row and returns a masked view", async () => {
      const res = await admin.patch("/api/platform/postfix-config", validPatchBody());
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.config.enabled).toBe(false);
      expect(body.config.sendingDomain).toBe("example.com");
      expect(body.config.mailHostname).toBe("mail.example.com");
      expect(body.config.senderAddress).toBe("no-reply@example.com");
      expect(body.config.hasDkimKey).toBe(false);
      expect(body.apply.ok).toBe(true);
      expect(res.body).not.toContain("dkimPrivateKeyCiphertext");
    });

    it("GET /api/platform/mail-delivery now reflects the saved postfix row with mode still smtp (enabled: false)", async () => {
      const res = await admin.get("/api/platform/mail-delivery");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.mode).toBe("smtp");
      expect(body.postfix).not.toBeNull();
      expect(body.postfix.sendingDomain).toBe("example.com");
    });
  });

  describe("POST /api/platform/postfix-config/dkim-key", () => {
    // Schema-level checks (unrecognized keyBits / mass-assignment) are
    // exercised directly against generateDkimKeySchema here rather than via
    // real HTTP calls — this route has a deliberately tight 5-per-15-minute
    // rate limit (see postfix-config.routes.ts's DKIM_KEY_RATE_LIMIT), and
    // this whole describe block's remaining tests need that budget for the
    // real generate/no-config-row/leak-check assertions below.
    it("schema rejects an unrecognized keyBits value and mass-assignment (no HTTP call needed)", () => {
      expect(generateDkimKeySchema.safeParse({ keyBits: 3000 }).success).toBe(false);
      expect(generateDkimKeySchema.safeParse({ keyBits: 2048, extra: true }).success).toBe(false);
      expect(generateDkimKeySchema.safeParse({ keyBits: 2048 }).success).toBe(true);
      expect(generateDkimKeySchema.safeParse({ keyBits: 4096 }).success).toBe(true);
    });

    it("generates a key, never returns the private key, and stores only a ciphertext at rest", async () => {
      const res = await admin.post("/api/platform/postfix-config/dkim-key", { keyBits: 2048 });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.dkim.selector).toBe("projecthub");
      expect(body.dkim.keyBits).toBe(2048);
      expect(body.dkim.dnsRecord.type).toBe("TXT");
      expect(body.dkim.dnsRecord.name).toBe("projecthub._domainkey.example.com");
      expect(typeof body.dkim.dnsRecord.value).toBe("string");
      expect(Array.isArray(body.dkim.dnsRecord.chunkedValue)).toBe(true);

      expect(res.body).not.toContain("PRIVATE KEY");
      expect(res.body).not.toContain("privateKey");
      expect(res.body).not.toContain("dkimPrivateKeyCiphertext");

      const row = await prisma.platformPostfixConfig.findUnique({ where: { id: "singleton" } });
      expect(row).not.toBeNull();
      expect(row!.dkimPrivateKeyCiphertext).not.toBeNull();
      expect(row!.dkimPrivateKeyCiphertext).not.toContain("PRIVATE KEY");
      expect(row!.dkimPublicKey).not.toBeNull();
      // Rotation always forces signing back off until DNS is republished.
      expect(row!.dkimSigningEnabled).toBe(false);

      const configRes = await admin.get("/api/platform/mail-delivery");
      expect(configRes.json().postfix.hasDkimKey).toBe(true);
      expect(configRes.body).not.toContain("dkimPrivateKeyCiphertext");
    });

    it("400s/422s when no config row has been saved yet (fresh singleton)", async () => {
      await prisma.platformPostfixConfig.deleteMany({});
      const res = await admin.post("/api/platform/postfix-config/dkim-key", { keyBits: 2048 });
      expect(res.statusCode).toBe(422);
      // restore for subsequent tests in this file
      await admin.patch("/api/platform/postfix-config", validPatchBody());
    });
  });

  describe("GET /api/platform/postfix-config/dns-check", () => {
    it("never throws — returns a best-effort report even when nothing resolves", async () => {
      const res = await admin.get("/api/platform/postfix-config/dns-check");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.bestEffort).toBe(true);
      expect(body.checks).toHaveProperty("a");
      expect(body.checks).toHaveProperty("spf");
      expect(body.checks).toHaveProperty("dkim");
      expect(body.checks).toHaveProperty("dmarc");
      expect(body.checks).toHaveProperty("ptr");
    }, 20000);
  });

  describe("routes that require the mail-control listener, unavailable in this test environment", () => {
    it("POST .../apply 422s when no config row is enabled", async () => {
      const res = await admin.post("/api/platform/postfix-config/apply");
      expect(res.statusCode).toBe(422);
    });

    it("POST .../validate surfaces the mail-control unavailability as a 503, never crashing the process", async () => {
      const res = await admin.post("/api/platform/postfix-config/validate", validPatchBody());
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("SELF_HOSTED_UNAVAILABLE");
    });

    it("GET .../status 503s", async () => {
      const res = await admin.get("/api/platform/postfix-config/status");
      expect(res.statusCode).toBe(503);
    });

    it("GET .../queue 503s", async () => {
      const res = await admin.get("/api/platform/postfix-config/queue");
      expect(res.statusCode).toBe(503);
    });

    it("POST .../test-email degrades to 200 {ok:false} rather than a 5xx (the caller's own request wasn't the problem)", async () => {
      const res = await admin.post("/api/platform/postfix-config/test-email");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.detail?.code).toBe("SELF_HOSTED_UNAVAILABLE");
    });
  });

  describe("MAIL_CONTROL_TOKEN never leaks into any response body", () => {
    const fakeToken = "test-mail-control-token-that-is-32-chars-plus-some-more";
    const originalUrl = env.MAIL_CONTROL_URL;
    const originalToken = env.MAIL_CONTROL_TOKEN;

    afterEach(() => {
      env.MAIL_CONTROL_URL = originalUrl;
      env.MAIL_CONTROL_TOKEN = originalToken;
      invalidateSelfHostedAvailability();
    });

    it("with a real (but unreachable) MAIL_CONTROL_URL/TOKEN configured, the reachability gate reports unreachable and the token string never appears in any response", async () => {
      // Port 1 is a reserved/unassigned port that reliably refuses
      // connections instantly — a real connection-level failure, not a
      // mock, exercising getSelfHostedAvailability()'s reachability gate.
      env.MAIL_CONTROL_URL = "http://127.0.0.1:1";
      env.MAIL_CONTROL_TOKEN = fakeToken;
      invalidateSelfHostedAvailability();

      const mailDeliveryRes = await admin.get("/api/platform/mail-delivery");
      expect(mailDeliveryRes.body).not.toContain(fakeToken);
      expect(mailDeliveryRes.json().selfHosted.reason).toBe("unreachable");

      const patchRes = await admin.patch("/api/platform/postfix-config", validPatchBody({ enabled: true }));
      expect(patchRes.statusCode).toBe(503);
      expect(patchRes.body).not.toContain(fakeToken);

      const statusRes = await admin.get("/api/platform/postfix-config/status");
      expect(statusRes.body).not.toContain(fakeToken);

      const testEmailRes = await admin.post("/api/platform/postfix-config/test-email");
      expect(testEmailRes.body).not.toContain(fakeToken);
    }, 20000);
  });

  describe("DELETE /api/platform/postfix-config", () => {
    it("removes the row; a subsequent GET reflects postfix: null again", async () => {
      const delRes = await admin.delete("/api/platform/postfix-config");
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json()).toEqual({ ok: true });

      const getRes = await admin.get("/api/platform/mail-delivery");
      expect(getRes.json().postfix).toBeNull();
      expect(getRes.json().mode).toBe("smtp");

      const row = await prisma.platformPostfixConfig.findUnique({ where: { id: "singleton" } });
      expect(row).toBeNull();
    });
  });
});
