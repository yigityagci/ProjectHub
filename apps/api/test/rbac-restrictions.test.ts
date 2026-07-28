import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  registerAndLogin,
  createWorkspaceAs,
  captureInvitationToken,
  type TestClient,
} from "./helpers.js";

async function inviteAndAccept(
  app: FastifyInstance,
  owner: TestClient,
  workspaceId: string,
  email: string,
  roleKey: string,
): Promise<TestClient> {
  const token = await captureInvitationToken(() =>
    owner.post(`/api/workspaces/${workspaceId}/invitations`, { email, roleKey }),
  );
  const member = await registerAndLogin(app, email);
  const acceptRes = await member.post(`/api/invitations/${token}/accept`);
  if (acceptRes.statusCode !== 200) {
    throw new Error(`Accept failed: ${acceptRes.statusCode} ${acceptRes.body}`);
  }
  return member;
}

describe("Role-based restrictions (RBAC)", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;
  let viewer: TestClient;
  let member: TestClient;
  let admin: TestClient;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "owner@example.com");
    const ws = await createWorkspaceAs(owner, "RBAC Co", "rbac-co");
    workspaceId = ws.id;

    viewer = await inviteAndAccept(app, owner, workspaceId, "viewer@example.com", "VIEWER");
    member = await inviteAndAccept(app, owner, workspaceId, "member@example.com", "MEMBER");
    admin = await inviteAndAccept(app, owner, workspaceId, "admin@example.com", "ADMIN");
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("VIEWER cannot invite members", async () => {
    const res = await viewer.post(`/api/workspaces/${workspaceId}/invitations`, {
      email: "nope@example.com",
      roleKey: "MEMBER",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe("You don't have permission to perform this action.");
  });

  it("VIEWER cannot change roles", async () => {
    const res = await viewer.patch(`/api/workspaces/${workspaceId}/members/${(await memberUserId())}/role`, {
      roleKey: "ADMIN",
    });
    expect(res.statusCode).toBe(403);
  });

  it("VIEWER cannot update workspace settings", async () => {
    const res = await viewer.patch(`/api/workspaces/${workspaceId}`, { name: "Renamed" });
    expect(res.statusCode).toBe(403);
  });

  it("MEMBER cannot change roles", async () => {
    const res = await member.patch(`/api/workspaces/${workspaceId}/members/${(await memberUserId())}/role`, {
      roleKey: "ADMIN",
    });
    expect(res.statusCode).toBe(403);
  });

  it("MEMBER cannot remove members", async () => {
    const res = await member.delete(`/api/workspaces/${workspaceId}/members/${(await memberUserId())}`);
    expect(res.statusCode).toBe(403);
  });

  it("MEMBER cannot manage settings", async () => {
    const res = await member.patch(`/api/workspaces/${workspaceId}`, { name: "Renamed Again" });
    expect(res.statusCode).toBe(403);
  });

  it("ADMIN can invite members (positive control)", async () => {
    const res = await admin.post(`/api/workspaces/${workspaceId}/invitations`, {
      email: "invited-by-admin@example.com",
      roleKey: "MEMBER",
    });
    expect(res.statusCode).toBe(201);
  });

  it("ADMIN can update workspace settings (positive control)", async () => {
    const res = await admin.patch(`/api/workspaces/${workspaceId}`, { name: "Renamed By Admin" });
    expect(res.statusCode).toBe(200);
  });

  it("OWNER can change a member's role (positive control)", async () => {
    const res = await owner.patch(`/api/workspaces/${workspaceId}/members/${(await memberUserId())}/role`, {
      roleKey: "PROJECT_MANAGER",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().member.role).toBe("PROJECT_MANAGER");
  });

  async function memberUserId(): Promise<string> {
    const res = await owner.get(`/api/workspaces/${workspaceId}/members`);
    const members = res.json().members as Array<{ email: string; userId: string }>;
    const found = members.find((m) => m.email === "member@example.com");
    if (!found) throw new Error("member not found");
    return found.userId;
  }
});
