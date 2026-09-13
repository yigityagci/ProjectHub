import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp, resetDatabase, closeTestApp, disconnectAll, freshClient, VALID_PASSWORD } from "./helpers.js";

describe("First-admin setup / bootstrap flow", () => {
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

  it("reports needsSetup:true on an empty database", async () => {
    const client = freshClient(app);
    const res = await client.get("/api/setup/status");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsSetup: true });
  });

  it("creates the first admin and auto-logs them in", async () => {
    const client = freshClient(app);
    const res = await client.post("/api/setup", {
      email: "admin@example.com",
      password: VALID_PASSWORD,
      displayName: "First Admin",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.email).toBe("admin@example.com");
    expect(res.cookies.some((c) => c.name === "ph_session")).toBe(true);

    const meRes = await client.get("/api/auth/me");
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.email).toBe("admin@example.com");

    const statusRes = await client.get("/api/setup/status");
    expect(statusRes.json()).toEqual({ needsSetup: false });

    // Self-hosted instances have no reason to make the admin manually
    // create a workspace before doing anything else — setup auto-creates
    // one and makes the new admin its OWNER.
    const workspacesRes = await client.get("/api/workspaces");
    expect(workspacesRes.statusCode).toBe(200);
    expect(workspacesRes.json().workspaces).toHaveLength(1);
    expect(workspacesRes.json().workspaces[0].role).toBe("OWNER");
  });

  it("rejects a second setup attempt once the first admin exists", async () => {
    const client = freshClient(app);
    await client.post("/api/setup", {
      email: "admin@example.com",
      password: VALID_PASSWORD,
      displayName: "First Admin",
    });

    const second = freshClient(app);
    const res = await second.post("/api/setup", {
      email: "someoneelse@example.com",
      password: VALID_PASSWORD,
      displayName: "Someone Else",
    });

    expect([403, 409]).toContain(res.statusCode);
    expect(res.json().error.message).toBe("Setup has already been completed.");
  });
});
