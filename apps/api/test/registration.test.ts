import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp, resetDatabase, closeTestApp, disconnectAll, freshClient, VALID_PASSWORD } from "./helpers.js";

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

  it("registers a new user successfully", async () => {
    const client = freshClient(app);
    const res = await client.post("/api/auth/register", {
      email: "alice@example.com",
      password: VALID_PASSWORD,
      displayName: "Alice",
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
    });

    const res = await client.post("/api/auth/register", {
      email: "bob@example.com",
      password: VALID_PASSWORD,
      displayName: "Bob Two",
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
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/at least 12 characters/);
  });
});
