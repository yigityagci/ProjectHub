import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  registerAndLogin,
  createWorkspaceAs,
  type TestClient,
} from "./helpers.js";

describe("Cross-workspace access / IDOR protection", () => {
  let app: FastifyInstance;
  let userA: TestClient;
  let w1Id: string;
  let w2Id: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    userA = await registerAndLogin(app, "usera@example.com");
    const w1 = await createWorkspaceAs(userA, "Workspace One", "workspace-one");
    w1Id = w1.id;

    const userB = await registerAndLogin(app, "userb@example.com");
    const w2 = await createWorkspaceAs(userB, "Workspace Two", "workspace-two");
    w2Id = w2.id;
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  const NOT_FOUND_MESSAGE = "This workspace doesn't exist or you don't have access to it.";

  it("GET /api/workspaces/:w2Id returns 404, not 403, for a non-member", async () => {
    const res = await userA.get(`/api/workspaces/${w2Id}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe(NOT_FOUND_MESSAGE);
  });

  it("GET /api/workspaces/:w2Id/members returns 404 for a non-member", async () => {
    const res = await userA.get(`/api/workspaces/${w2Id}/members`);
    expect(res.statusCode).toBe(404);
  });

  it("POST invitations into w2 returns 404 for a non-member", async () => {
    const res = await userA.post(`/api/workspaces/${w2Id}/invitations`, {
      email: "someone@example.com",
      roleKey: "MEMBER",
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH role in w2 returns 404 for a non-member", async () => {
    const res = await userA.patch(`/api/workspaces/${w2Id}/members/someone-id/role`, {
      roleKey: "ADMIN",
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH settings on w2 returns 404 for a non-member", async () => {
    const res = await userA.patch(`/api/workspaces/${w2Id}`, { name: "Hacked" });
    expect(res.statusCode).toBe(404);
  });

  it("w2 is not present in userA's workspace list", async () => {
    const res = await userA.get("/api/workspaces");
    expect(res.statusCode).toBe(200);
    const ids = res.json().workspaces.map((w: { id: string }) => w.id);
    expect(ids).not.toContain(w2Id);
  });
});
