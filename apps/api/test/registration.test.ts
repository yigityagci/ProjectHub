import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  freshClient,
  getFreshRegistrationToken,
  VALID_PASSWORD,
} from "./helpers.js";
import { prisma } from "../src/core/prisma.js";

const REGISTRATION_TOKEN_INVALID_MESSAGE =
  "This registration token is invalid or has expired. Please ask a workspace admin for a new one.";

describe("Registration", () => {
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

  it("registers a new user successfully with a valid registration token", async () => {
    const client = freshClient(app);
    const registrationToken = await getFreshRegistrationToken();
    const res = await client.post("/api/auth/register", {
      email: "alice@example.com",
      password: VALID_PASSWORD,
      displayName: "Alice",
      registrationToken,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.email).toBe("alice@example.com");
    // Password must never be returned.
    expect(res.body).not.toContain("passwordHash");
    expect(res.body).not.toContain(VALID_PASSWORD);
  });

  it("rejects duplicate email with a generic message", async () => {
    const client = freshClient(app);
    await client.post("/api/auth/register", {
      email: "bob@example.com",
      password: VALID_PASSWORD,
      displayName: "Bob",
      registrationToken: await getFreshRegistrationToken(),
    });

    const res = await client.post("/api/auth/register", {
      email: "bob@example.com",
      password: VALID_PASSWORD,
      displayName: "Bob Two",
      registrationToken: await getFreshRegistrationToken(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(
      "An account with this email address already exists.",
    );
  });

  it("enforces the password policy", async () => {
    const client = freshClient(app);
    const res = await client.post("/api/auth/register", {
      email: "weakpass@example.com",
      password: "short1A!",
      displayName: "Weak Pass",
      registrationToken: await getFreshRegistrationToken(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/at least 12 characters/);
  });

  it("rejects registration with no registration token at all", async () => {
    const client = freshClient(app);
    const res = await client.post("/api/auth/register", {
      email: "no-token@example.com",
      password: VALID_PASSWORD,
      displayName: "No Token",
    } as unknown as Record<string, unknown>);
    // Strict schema: registrationToken is a required field.
    expect(res.statusCode).toBe(422);

    const created = await prisma.user.findUnique({ where: { email: "no-token@example.com" } });
    expect(created).toBeNull();
  });

  it("rejects registration with a garbage/nonexistent registration token, with the generic message", async () => {
    const client = freshClient(app);
    const res = await client.post("/api/auth/register", {
      email: "garbage-token@example.com",
      password: VALID_PASSWORD,
      displayName: "Garbage Token",
      registrationToken: "not-a-real-token-at-all",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe(REGISTRATION_TOKEN_INVALID_MESSAGE);

    const created = await prisma.user.findUnique({ where: { email: "garbage-token@example.com" } });
    expect(created).toBeNull();
  });

  it("rejects registration with an expired registration token, with the generic message", async () => {
    const registrationToken = await getFreshRegistrationToken();
    await prisma.registrationToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
      where: {},
    });

    const client = freshClient(app);
    const res = await client.post("/api/auth/register", {
      email: "expired-token@example.com",
      password: VALID_PASSWORD,
      displayName: "Expired Token",
      registrationToken,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe(REGISTRATION_TOKEN_INVALID_MESSAGE);
  });

  it("rejects registration with a revoked registration token, with the generic message", async () => {
    const registrationToken = await getFreshRegistrationToken();
    await prisma.registrationToken.updateMany({
      data: { revokedAt: new Date() },
      where: {},
    });

    const client = freshClient(app);
    const res = await client.post("/api/auth/register", {
      email: "revoked-token@example.com",
      password: VALID_PASSWORD,
      displayName: "Revoked Token",
      registrationToken,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe(REGISTRATION_TOKEN_INVALID_MESSAGE);
  });

  it("a valid token becomes unusable after a successful registration (cannot be reused)", async () => {
    const registrationToken = await getFreshRegistrationToken();

    const first = await freshClient(app).post("/api/auth/register", {
      email: "once-first@example.com",
      password: VALID_PASSWORD,
      displayName: "Once First",
      registrationToken,
    });
    expect(first.statusCode).toBe(201);

    const second = await freshClient(app).post("/api/auth/register", {
      email: "once-second@example.com",
      password: VALID_PASSWORD,
      displayName: "Once Second",
      registrationToken,
    });
    expect(second.statusCode).toBe(404);
    expect(second.json().error.message).toBe(REGISTRATION_TOKEN_INVALID_MESSAGE);

    const secondUser = await prisma.user.findUnique({ where: { email: "once-second@example.com" } });
    expect(secondUser).toBeNull();
  });

  it("a failed registration (duplicate email) with an otherwise-valid token does NOT consume the token — it stays retryable", async () => {
    const existingEmail = "already-taken@example.com";
    await freshClient(app).post("/api/auth/register", {
      email: existingEmail,
      password: VALID_PASSWORD,
      displayName: "Already Taken",
      registrationToken: await getFreshRegistrationToken(),
    });

    const registrationToken = await getFreshRegistrationToken();

    const failedAttempt = await freshClient(app).post("/api/auth/register", {
      email: existingEmail,
      password: VALID_PASSWORD,
      displayName: "Duplicate Attempt",
      registrationToken,
    });
    expect(failedAttempt.statusCode).toBe(409);

    // The same token still works, with a corrected/different email.
    const retry = await freshClient(app).post("/api/auth/register", {
      email: "corrected-email@example.com",
      password: VALID_PASSWORD,
      displayName: "Corrected",
      registrationToken,
    });
    expect(retry.statusCode).toBe(201);
  });

  it("registering with a valid token joins the new user to the token's workspace with the token's role", async () => {
    const registrationToken = await getFreshRegistrationToken("PROJECT_MANAGER");
    const res = await freshClient(app).post("/api/auth/register", {
      email: "auto-membership@example.com",
      password: VALID_PASSWORD,
      displayName: "Auto Membership",
      registrationToken,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe("PROJECT_MANAGER");
    expect(res.json().workspace.name).toBeTruthy();

    const memberships = await prisma.workspaceMembership.findMany({
      where: { user: { email: "auto-membership@example.com" } },
      include: { role: true },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.role.key).toBe("PROJECT_MANAGER");
  });
});
