import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("Platform-wide email configuration (/api/platform/email-config)", () => {
  let app: FastifyInstance;
  let admin: TestClient;
  let nonAdmin: TestClient;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    // The very first user created via POST /api/setup is the platform
    // admin (see setup.routes.ts) — every other user registered afterward
    // is not.
    const setup = await completeSetup(app, "platform-email-admin@example.com");
    admin = setup.client;
    nonAdmin = await registerAndLogin(app, "platform-email-plain-member@example.com");
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("unauthenticated callers get 401 on all four routes", async () => {
    const anon = freshClient(app);
    expect((await anon.get("/api/platform/email-config")).statusCode).toBe(401);
    expect((await anon.patch("/api/platform/email-config", {})).statusCode).toBe(401);
    expect((await anon.post("/api/platform/email-config/test")).statusCode).toBe(401);
    expect((await anon.delete("/api/platform/email-config")).statusCode).toBe(401);
  });

  it("a non-platform-admin gets 403 on all four routes", async () => {
    expect((await nonAdmin.get("/api/platform/email-config")).statusCode).toBe(403);
    expect(
      (
        await nonAdmin.patch("/api/platform/email-config", {
          enabled: false,
          host: "smtp.example.com",
          port: 587,
          security: "starttls",
          fromAddress: "no-reply@example.com",
        })
      ).statusCode,
    ).toBe(403);
    expect((await nonAdmin.post("/api/platform/email-config/test")).statusCode).toBe(403);
    expect((await nonAdmin.delete("/api/platform/email-config")).statusCode).toBe(403);
  });

  it("GET returns config: null before anything has ever been saved", async () => {
    const res = await admin.get("/api/platform/email-config");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ config: null });
  });

  it("PATCH saves the config; the response and every subsequent GET never leak the password, only hasPassword", async () => {
    const patchRes = await admin.patch("/api/platform/email-config", {
      enabled: true,
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      username: "no-reply",
      password: "super-secret-smtp-password",
      fromAddress: "no-reply@example.com",
      fromName: "ProjectHub",
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.body).not.toContain("passwordCiphertext");
    expect(patchRes.body).not.toContain("super-secret-smtp-password");

    const config = patchRes.json().config;
    expect(config.enabled).toBe(true);
    expect(config.host).toBe("smtp.example.com");
    expect(config.port).toBe(587);
    expect(config.security).toBe("starttls");
    expect(config.username).toBe("no-reply");
    expect(config.hasPassword).toBe(true);
    expect(config.password).toBeUndefined();
    expect(config.fromAddress).toBe("no-reply@example.com");
    expect(config.fromName).toBe("ProjectHub");
    expect(config.updatedByDisplayName).toBe("First Admin");

    const getRes = await admin.get("/api/platform/email-config");
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).not.toContain("passwordCiphertext");
    expect(getRes.body).not.toContain("super-secret-smtp-password");
    expect(getRes.json().config.hasPassword).toBe(true);

    // The ciphertext is never returned over the wire, but it must actually
    // be encrypted (not the plaintext) at rest.
    const row = await prisma.platformEmailConfig.findUnique({ where: { id: "singleton" } });
    expect(row).not.toBeNull();
    expect(row!.passwordCiphertext).not.toBeNull();
    expect(row!.passwordCiphertext).not.toBe("super-secret-smtp-password");
  });

  it("PATCH with password omitted preserves the existing stored ciphertext", async () => {
    const before = await prisma.platformEmailConfig.findUnique({ where: { id: "singleton" } });
    expect(before!.passwordCiphertext).not.toBeNull();

    const res = await admin.patch("/api/platform/email-config", {
      enabled: true,
      host: "smtp.example.com",
      port: 2525,
      security: "tls",
      username: "no-reply",
      // password intentionally omitted -> keep existing ciphertext
      fromAddress: "no-reply@example.com",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.hasPassword).toBe(true);
    expect(res.json().config.port).toBe(2525);
    expect(res.json().config.security).toBe("tls");

    const after = await prisma.platformEmailConfig.findUnique({ where: { id: "singleton" } });
    expect(after!.passwordCiphertext).toBe(before!.passwordCiphertext);
  });

  it("PATCH with password: null clears the stored password (hasPassword becomes false)", async () => {
    const res = await admin.patch("/api/platform/email-config", {
      enabled: true,
      host: "smtp.example.com",
      port: 2525,
      security: "tls",
      username: "no-reply",
      password: null,
      fromAddress: "no-reply@example.com",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.hasPassword).toBe(false);

    const row = await prisma.platformEmailConfig.findUnique({ where: { id: "singleton" } });
    expect(row!.passwordCiphertext).toBeNull();
  });

  it("enabled: false keeps the dev/console mail transport active — sending while disabled doesn't throw", async () => {
    const disableRes = await admin.patch("/api/platform/email-config", {
      enabled: false,
      host: "smtp.example.com",
      port: 2525,
      security: "tls",
      username: "no-reply",
      fromAddress: "no-reply@example.com",
    });
    expect(disableRes.statusCode).toBe(200);
    expect(disableRes.json().config.enabled).toBe(false);

    // With enabled:false, resolveTransport() returns null and deliverEmail
    // falls back to the console transport unconditionally — this must
    // resolve successfully (ok: true), never attempt (or fail) a real SMTP
    // connection to the bogus host above.
    const testRes = await admin.post("/api/platform/email-config/test");
    expect(testRes.statusCode).toBe(200);
    expect(testRes.json().ok).toBe(true);
  });

  it("DELETE removes the config row; a subsequent GET returns null again", async () => {
    const delRes = await admin.delete("/api/platform/email-config");
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json()).toEqual({ ok: true });

    const getRes = await admin.get("/api/platform/email-config");
    expect(getRes.json()).toEqual({ config: null });

    const row = await prisma.platformEmailConfig.findUnique({ where: { id: "singleton" } });
    expect(row).toBeNull();
  });
});
