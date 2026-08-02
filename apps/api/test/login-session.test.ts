import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  freshClient,
  registerAndLogin,
  getFreshRegistrationToken,
  VALID_PASSWORD,
} from "./helpers.js";
import { prisma } from "../src/core/prisma.js";

describe("Login / session lifecycle", () => {
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

  it("sets an httpOnly session cookie on successful login", async () => {
    const anon = freshClient(app);
    await anon.post("/api/auth/register", {
      email: "carol@example.com",
      password: VALID_PASSWORD,
      displayName: "Carol",
      registrationToken: await getFreshRegistrationToken(),
    });

    const client = freshClient(app);
    const res = await client.post("/api/auth/login", {
      email: "carol@example.com",
      password: VALID_PASSWORD,
    });
    expect(res.statusCode).toBe(200);

    const sessionCookie = res.cookies.find((c) => c.name === "ph_session");
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie?.httpOnly).toBe(true);
  });

  it("rejects wrong password with 401 and audits login.failed", async () => {
    const anon = freshClient(app);
    await anon.post("/api/auth/register", {
      email: "dave@example.com",
      password: VALID_PASSWORD,
      displayName: "Dave",
      registrationToken: await getFreshRegistrationToken(),
    });

    const client = freshClient(app);
    const res = await client.post("/api/auth/login", {
      email: "dave@example.com",
      password: "TotallyWrongPassword1!",
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("Invalid email or password. Please try again.");

    const entries = await prisma.auditLogEntry.findMany({ where: { action: "login.failed" } });
    expect(entries.length).toBe(1);
  });

  it("returns the same generic message for an unknown email", async () => {
    const client = freshClient(app);
    const res = await client.post("/api/auth/login", {
      email: "doesnotexist@example.com",
      password: VALID_PASSWORD,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("Invalid email or password. Please try again.");
  });

  it("logout revokes the session so the old cookie no longer authenticates", async () => {
    const client = await registerAndLogin(app, "erin@example.com");

    const meBefore = await client.get("/api/auth/me");
    expect(meBefore.statusCode).toBe(200);

    const logoutRes = await client.post("/api/auth/logout");
    expect(logoutRes.statusCode).toBe(200);

    const meAfter = await client.get("/api/auth/me");
    expect(meAfter.statusCode).toBe(401);
  });
});
