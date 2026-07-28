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

async function userIdByEmail(owner: TestClient, workspaceId: string, email: string): Promise<string> {
  const res = await owner.get(`/api/workspaces/${workspaceId}/members`);
  const members = res.json().members as Array<{ email: string; userId: string }>;
  const found = members.find((m) => m.email === email);
  if (!found) throw new Error(`member ${email} not found`);
  return found.userId;
}

describe("Permission changes take effect immediately (no stale session cache)", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;
  let userB: TestClient;
  let userBId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "owner@example.com");
    const ws = await createWorkspaceAs(owner, "Immediacy Co", "immediacy-co");
    workspaceId = ws.id;
    userB = await inviteAndAccept(app, owner, workspaceId, "userb@example.com", "MEMBER");
    userBId = await userIdByEmail(owner, workspaceId, "userb@example.com");
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("B (MEMBER) initially cannot manage settings", async () => {
    const res = await userB.patch(`/api/workspaces/${workspaceId}`, { name: "Nope" });
    expect(res.statusCode).toBe(403);
  });

  it("after being promoted to ADMIN, B's very next request succeeds without a new login", async () => {
    const promote = await owner.patch(`/api/workspaces/${workspaceId}/members/${userBId}/role`, {
      roleKey: "ADMIN",
    });
    expect(promote.statusCode).toBe(200);

    // Same TestClient/session as before — no re-login, no new cookie.
    const res = await userB.patch(`/api/workspaces/${workspaceId}`, { name: "Now Allowed" });
    expect(res.statusCode).toBe(200);
  });

  it("after being demoted to VIEWER, B's very next editing request is immediately forbidden", async () => {
    const demote = await owner.patch(`/api/workspaces/${workspaceId}/members/${userBId}/role`, {
      roleKey: "VIEWER",
    });
    expect(demote.statusCode).toBe(200);

    const res = await userB.patch(`/api/workspaces/${workspaceId}`, { name: "Should Fail" });
    expect(res.statusCode).toBe(403);
  });
});
