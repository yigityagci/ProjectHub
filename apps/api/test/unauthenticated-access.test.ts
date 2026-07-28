import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  freshClient,
  registerAndLogin,
  createWorkspaceAs,
} from "./helpers.js";

describe("Unauthenticated access is blocked on every protected route", () => {
  let app: FastifyInstance;
  let workspaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    const owner = await registerAndLogin(app, "owner@example.com");
    const ws = await createWorkspaceAs(owner, "Acme", "acme");
    workspaceId = ws.id;
  });
  afterEach(async () => {
    // Nothing to reset between these read-only assertions; state is
    // established once in beforeAll and each request here is unauthenticated.
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("GET /api/workspaces requires auth", async () => {
    const anon = freshClient(app);
    const res = await anon.get("/api/workspaces");
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("AUTH_REQUIRED");
  });

  it("GET /api/workspaces/:id requires auth", async () => {
    const anon = freshClient(app);
    const res = await anon.get(`/api/workspaces/${workspaceId}`);
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/workspaces/:id/members requires auth", async () => {
    const anon = freshClient(app);
    const res = await anon.get(`/api/workspaces/${workspaceId}/members`);
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/workspaces/:id/invitations requires auth", async () => {
    const anon = freshClient(app);
    const res = await anon.post(`/api/workspaces/${workspaceId}/invitations`, {
      email: "x@example.com",
      roleKey: "MEMBER",
    });
    expect(res.statusCode).toBe(401);
  });

  it("PATCH /api/workspaces/:id requires auth", async () => {
    const anon = freshClient(app);
    const res = await anon.patch(`/api/workspaces/${workspaceId}`, { name: "New Name" });
    expect(res.statusCode).toBe(401);
  });

  it("none of the above leak any workspace data in the response body", async () => {
    const anon = freshClient(app);
    const res = await anon.get(`/api/workspaces/${workspaceId}`);
    expect(res.body).not.toContain("Acme");
    expect(res.body).not.toContain(workspaceId);
  });
});
