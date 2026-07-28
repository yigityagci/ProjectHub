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

async function memberUserIdByEmail(
  owner: TestClient,
  workspaceId: string,
  email: string,
): Promise<string> {
  const res = await owner.get(`/api/workspaces/${workspaceId}/members`);
  const members = res.json().members as Array<{ email: string; userId: string }>;
  const found = members.find((m) => m.email === email);
  if (!found) throw new Error(`member ${email} not found`);
  return found.userId;
}

describe("Rank rule and last-owner protection", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;
  let admin: TestClient;
  let ownerUserId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "owner@example.com");
    const ws = await createWorkspaceAs(owner, "Rank Co", "rank-co");
    workspaceId = ws.id;
    admin = await inviteAndAccept(app, owner, workspaceId, "admin@example.com", "ADMIN");
    ownerUserId = await memberUserIdByEmail(owner, workspaceId, "owner@example.com");
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("an ADMIN cannot assign a role higher than their own rank (OWNER)", async () => {
    const adminUserId = await memberUserIdByEmail(owner, workspaceId, "admin@example.com");
    const res = await admin.patch(`/api/workspaces/${workspaceId}/members/${adminUserId}/role`, {
      roleKey: "OWNER",
    });
    expect(res.statusCode).toBe(403);
  });

  it("cannot demote the last remaining OWNER", async () => {
    const res = await owner.patch(`/api/workspaces/${workspaceId}/members/${ownerUserId}/role`, {
      roleKey: "ADMIN",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/at least one owner/);
  });

  it("cannot remove the last remaining OWNER", async () => {
    const res = await owner.delete(`/api/workspaces/${workspaceId}/members/${ownerUserId}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/only owner/);
  });

  it("promoting a second OWNER allows the first to then be demoted", async () => {
    const adminUserId = await memberUserIdByEmail(owner, workspaceId, "admin@example.com");
    const promote = await owner.patch(
      `/api/workspaces/${workspaceId}/members/${adminUserId}/role`,
      { roleKey: "OWNER" },
    );
    expect(promote.statusCode).toBe(200);

    const demote = await owner.patch(
      `/api/workspaces/${workspaceId}/members/${ownerUserId}/role`,
      { roleKey: "ADMIN" },
    );
    expect(demote.statusCode).toBe(200);
  });
});
