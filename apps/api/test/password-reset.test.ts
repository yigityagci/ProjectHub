import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  freshClient,
  registerAndLogin,
  VALID_PASSWORD,
} from "./helpers.js";
import { prisma } from "../src/core/prisma.js";
import { hashToken } from "../src/auth/session.js";

const GENERIC_INVALID_MESSAGE =
  "This password reset link is invalid or has expired. Please request a new one.";

/**
 * Runs `action` while capturing console.log output, and extracts the raw
 * reset token from the dev mail transport's logged reset link
 * (`.../reset-password?token=<rawToken>`) — mirrors
 * helpers.ts#captureInvitationToken for the password-reset flow.
 */
async function captureResetToken(action: () => Promise<unknown>): Promise<string | null> {
  const logs: string[] = [];
  const original = console.log;
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await action();
    // The password-reset send is deliberately fire-and-forget (for
    // anti-enumeration response-timing) and, per email.service.ts's
    // resolveTransport, now does a real DB round-trip (re-reading the
    // platform email config) on every send before falling back to this
    // dev/console transport — so the console.log below may not have
    // happened yet the instant action() resolves. Poll briefly rather than
    // racing against it; this returns immediately once the token appears.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !/reset-password\?token=/.test(logs.join("\n"))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    console.log = original;
  }
  const joined = logs.join("\n");
  const match = joined.match(/reset-password\?token=([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

describe("Password reset flow", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
  });
  afterEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("returns a generic 200 for an unknown email and creates no token row", async () => {
    const client = freshClient(app);
    const res = await client.post("/api/auth/password-reset/request", {
      email: "nobody@example.com",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const tokens = await prisma.passwordResetToken.findMany();
    expect(tokens.length).toBe(0);
  });

  it("full happy path: request -> confirm updates the password, marks the token used, and revokes prior sessions", async () => {
    const email = "reset-happy@example.com";
    const oldSessionClient = await registerAndLogin(app, email);

    const meBefore = await oldSessionClient.get("/api/auth/me");
    expect(meBefore.statusCode).toBe(200);

    const rawToken = await captureResetToken(() =>
      freshClient(app).post("/api/auth/password-reset/request", { email }),
    );
    expect(rawToken).toBeTruthy();

    const newPassword = "NewStr0ng!Passw0rd#";
    const confirmClient = freshClient(app);
    const confirmRes = await confirmClient.post("/api/auth/password-reset/confirm", {
      token: rawToken,
      password: newPassword,
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json()).toEqual({ ok: true });

    // The token is now marked used.
    const tokenRow = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(rawToken!) },
    });
    expect(tokenRow?.usedAt).not.toBeNull();

    // The previously-valid session cookie can no longer authenticate.
    const meAfter = await oldSessionClient.get("/api/auth/me");
    expect(meAfter.statusCode).toBe(401);

    // The new password actually works for a fresh login.
    const loginRes = await freshClient(app).post("/api/auth/login", {
      email,
      password: newPassword,
    });
    expect(loginRes.statusCode).toBe(200);

    // The old password no longer works.
    const oldLoginRes = await freshClient(app).post("/api/auth/login", {
      email,
      password: VALID_PASSWORD,
    });
    expect(oldLoginRes.statusCode).toBe(401);
  });

  it("an expired token is rejected with the generic 404 message", async () => {
    const email = "reset-expired@example.com";
    await registerAndLogin(app, email);

    const rawToken = await captureResetToken(() =>
      freshClient(app).post("/api/auth/password-reset/request", { email }),
    );
    expect(rawToken).toBeTruthy();

    await prisma.passwordResetToken.updateMany({
      where: { tokenHash: hashToken(rawToken!) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await freshClient(app).post("/api/auth/password-reset/confirm", {
      token: rawToken,
      password: "AnotherStr0ng!Passw0rd#",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe(GENERIC_INVALID_MESSAGE);
  });

  it("an already-used token is rejected with the same generic 404 message", async () => {
    const email = "reset-used@example.com";
    await registerAndLogin(app, email);

    const rawToken = await captureResetToken(() =>
      freshClient(app).post("/api/auth/password-reset/request", { email }),
    );
    expect(rawToken).toBeTruthy();

    const first = await freshClient(app).post("/api/auth/password-reset/confirm", {
      token: rawToken,
      password: "FirstNewStr0ng!Passw0rd#",
    });
    expect(first.statusCode).toBe(200);

    const second = await freshClient(app).post("/api/auth/password-reset/confirm", {
      token: rawToken,
      password: "SecondNewStr0ng!Passw0rd#",
    });
    expect(second.statusCode).toBe(404);
    expect(second.json().error.message).toBe(GENERIC_INVALID_MESSAGE);
  });

  it("a second request while a token is outstanding invalidates the first token", async () => {
    const email = "reset-superseded@example.com";
    await registerAndLogin(app, email);

    const firstToken = await captureResetToken(() =>
      freshClient(app).post("/api/auth/password-reset/request", { email }),
    );
    expect(firstToken).toBeTruthy();

    const secondToken = await captureResetToken(() =>
      freshClient(app).post("/api/auth/password-reset/request", { email }),
    );
    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);

    // The old token no longer works.
    const oldRes = await freshClient(app).post("/api/auth/password-reset/confirm", {
      token: firstToken,
      password: "ShouldNotWork1!Passw0rd#",
    });
    expect(oldRes.statusCode).toBe(404);
    expect(oldRes.json().error.message).toBe(GENERIC_INVALID_MESSAGE);

    // The new token still works.
    const newRes = await freshClient(app).post("/api/auth/password-reset/confirm", {
      token: secondToken,
      password: "ShouldWork1!Passw0rd#",
    });
    expect(newRes.statusCode).toBe(200);
  });

  it("returns 404 for a garbage/nonexistent token", async () => {
    const res = await freshClient(app).post("/api/auth/password-reset/confirm", {
      token: "not-a-real-token-at-all",
      password: "SomeStr0ng!Passw0rd#",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe(GENERIC_INVALID_MESSAGE);
  });

  it("audits password_reset.requested and password_reset.completed", async () => {
    const email = "reset-audit@example.com";
    await registerAndLogin(app, email);

    const rawToken = await captureResetToken(() =>
      freshClient(app).post("/api/auth/password-reset/request", { email }),
    );
    const requested = await prisma.auditLogEntry.findMany({
      where: { action: "password_reset.requested" },
    });
    expect(requested.length).toBeGreaterThanOrEqual(1);

    const confirmRes = await freshClient(app).post("/api/auth/password-reset/confirm", {
      token: rawToken,
      password: "AuditedStr0ng!Passw0rd#",
    });
    expect(confirmRes.statusCode).toBe(200);

    const completed = await prisma.auditLogEntry.findMany({
      where: { action: "password_reset.completed" },
    });
    expect(completed.length).toBeGreaterThanOrEqual(1);
  });
});
