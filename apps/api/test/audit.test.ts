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
  freshClient,
  type TestClient,
} from "./helpers.js";
import { prisma } from "../src/core/prisma.js";

const SECRET_LIKE_PATTERN = /(password|token|secret|authorization|cookie)/i;

function assertNoSecretsInMetadata(metadata: unknown) {
  const serialized = JSON.stringify(metadata ?? {});
  // Look for suspicious keys; values themselves should also not resemble
  // a raw session/invite token (long random base64url strings).
  if (metadata && typeof metadata === "object") {
    for (const key of Object.keys(metadata as Record<string, unknown>)) {
      expect(key).not.toMatch(SECRET_LIKE_PATTERN);
    }
  }
  expect(serialized).not.toMatch(/passwordHash/i);
}

describe("Audit log correctness", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("admin.setup.completed is recorded", async () => {
    const client = freshClient(app);
    const res = await client.post("/api/setup", {
      email: "firstadmin@example.com",
      password: "Str0ng!Passw0rd#",
      displayName: "First Admin",
    });
    expect(res.statusCode).toBe(201);

    const entries = await prisma.auditLogEntry.findMany({ where: { action: "admin.setup.completed" } });
    expect(entries.length).toBe(1);
    assertNoSecretsInMetadata(entries[0]!.metadata);
  });

  it("member.invited, role.changed, member.removed, workspace.settings.updated, session.revoked are all recorded with clean metadata", async () => {
    owner = await registerAndLogin(app, "audit-owner@example.com");
    const ws = await createWorkspaceAs(owner, "Audit Co", "audit-co");
    workspaceId = ws.id;

    const invitedEmail = "audit-invitee@example.com";
    await captureInvitationToken(() =>
      owner.post(`/api/workspaces/${workspaceId}/invitations`, {
        email: invitedEmail,
        roleKey: "MEMBER",
      }),
    );

    const invited = await prisma.auditLogEntry.findMany({ where: { action: "member.invited" } });
    expect(invited.length).toBeGreaterThanOrEqual(1);
    assertNoSecretsInMetadata(invited[0]!.metadata);

    const settingsRes = await owner.patch(`/api/workspaces/${workspaceId}`, { name: "Audit Co Renamed" });
    expect(settingsRes.statusCode).toBe(200);
    const settingsEntries = await prisma.auditLogEntry.findMany({
      where: { action: "workspace.settings.updated" },
    });
    expect(settingsEntries.length).toBeGreaterThanOrEqual(1);
    assertNoSecretsInMetadata(settingsEntries[0]!.metadata);

    // Promote self isn't meaningful (already OWNER); instead invite+accept
    // a second member, promote, then remove, to exercise role.changed and
    // member.removed.
    const secondEmail = "audit-second@example.com";
    const token = await captureInvitationToken(() =>
      owner.post(`/api/workspaces/${workspaceId}/invitations`, {
        email: secondEmail,
        roleKey: "MEMBER",
      }),
    );
    const secondClient = await registerAndLogin(app, secondEmail);
    await secondClient.post(`/api/invitations/${token}/accept`);

    const membersAfter = await owner.get(`/api/workspaces/${workspaceId}/members`);
    const secondUserId = (membersAfter.json().members as Array<{ email: string; userId: string }>).find(
      (m) => m.email === secondEmail,
    )!.userId;

    const roleChangeRes = await owner.patch(
      `/api/workspaces/${workspaceId}/members/${secondUserId}/role`,
      { roleKey: "ADMIN" },
    );
    expect(roleChangeRes.statusCode).toBe(200);

    const roleChanged = await prisma.auditLogEntry.findMany({ where: { action: "role.changed" } });
    expect(roleChanged.length).toBeGreaterThanOrEqual(1);
    assertNoSecretsInMetadata(roleChanged[0]!.metadata);

    const removeRes = await owner.delete(`/api/workspaces/${workspaceId}/members/${secondUserId}`);
    expect(removeRes.statusCode).toBe(200);

    const removed = await prisma.auditLogEntry.findMany({ where: { action: "member.removed" } });
    expect(removed.length).toBeGreaterThanOrEqual(1);
    assertNoSecretsInMetadata(removed[0]!.metadata);

    const sessionsRes = await owner.get("/api/auth/sessions");
    const sessionId = (sessionsRes.json().sessions as Array<{ id: string }>)[0]!.id;
    const revokeRes = await owner.post(`/api/auth/sessions/${sessionId}/revoke`);
    expect(revokeRes.statusCode).toBe(200);

    const revoked = await prisma.auditLogEntry.findMany({ where: { action: "session.revoked" } });
    expect(revoked.length).toBeGreaterThanOrEqual(1);
    assertNoSecretsInMetadata(revoked[0]!.metadata);
  });
});
