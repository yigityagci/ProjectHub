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

describe("Invitation token flow end-to-end", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    owner = await registerAndLogin(app, "owner@example.com");
    const ws = await createWorkspaceAs(owner, "Invite Co", "invite-co");
    workspaceId = ws.id;
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("full happy path: create -> preview -> register/login -> accept", async () => {
    const invitedEmail = "invitee@example.com";
    const token = await captureInvitationToken(() =>
      owner.post(`/api/workspaces/${workspaceId}/invitations`, {
        email: invitedEmail,
        roleKey: "MEMBER",
      }),
    );
    expect(token).toBeTruthy();

    const preview = await freshClient(app).get(`/api/invitations/${token}`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().workspaceName).toBe("Invite Co");
    expect(preview.json().roleKey).toBe("MEMBER");

    const invitee = await registerAndLogin(app, invitedEmail);
    const acceptRes = await invitee.post(`/api/invitations/${token}/accept`);
    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.json().role).toBe("MEMBER");

    const membership = await prisma.workspaceMembership.findFirst({
      where: { workspaceId, user: { email: invitedEmail } },
    });
    expect(membership).not.toBeNull();
  });

  it("a second accept attempt on the same token is rejected", async () => {
    const invitedEmail = "twice@example.com";
    const token = await captureInvitationToken(() =>
      owner.post(`/api/workspaces/${workspaceId}/invitations`, {
        email: invitedEmail,
        roleKey: "MEMBER",
      }),
    );

    const invitee = await registerAndLogin(app, invitedEmail);
    const first = await invitee.post(`/api/invitations/${token}/accept`);
    expect(first.statusCode).toBe(200);

    const second = await invitee.post(`/api/invitations/${token}/accept`);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toBe("This invitation has already been used.");
  });

  it("an expired token is rejected", async () => {
    const invitedEmail = "expired@example.com";
    const token = await captureInvitationToken(() =>
      owner.post(`/api/workspaces/${workspaceId}/invitations`, {
        email: invitedEmail,
        roleKey: "MEMBER",
      }),
    );

    await prisma.invitation.updateMany({
      where: { email: invitedEmail },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const preview = await freshClient(app).get(`/api/invitations/${token}`);
    expect(preview.statusCode).toBe(409);
    expect(preview.json().error.message).toMatch(/invalid or has expired/);

    const invitee = await registerAndLogin(app, invitedEmail);
    const acceptRes = await invitee.post(`/api/invitations/${token}/accept`);
    expect(acceptRes.statusCode).toBe(409);
  });

  it("a revoked token is rejected", async () => {
    const invitedEmail = "revoked@example.com";
    const token = await captureInvitationToken(() =>
      owner.post(`/api/workspaces/${workspaceId}/invitations`, {
        email: invitedEmail,
        roleKey: "MEMBER",
      }),
    );

    const invitation = await prisma.invitation.findFirst({ where: { email: invitedEmail } });
    const revokeRes = await owner.post(
      `/api/workspaces/${workspaceId}/invitations/${invitation!.id}/revoke`,
    );
    expect(revokeRes.statusCode).toBe(200);

    const preview = await freshClient(app).get(`/api/invitations/${token}`);
    expect(preview.statusCode).toBe(409);
    expect(preview.json().error.message).toBe("This invitation has been revoked.");
  });

  it("accepting while signed in as a different email is rejected with a clear error", async () => {
    const invitedEmail = "targeted@example.com";
    const token = await captureInvitationToken(() =>
      owner.post(`/api/workspaces/${workspaceId}/invitations`, {
        email: invitedEmail,
        roleKey: "MEMBER",
      }),
    );

    const differentUser = await registerAndLogin(app, "different@example.com");
    const res = await differentUser.post(`/api/invitations/${token}/accept`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/doesn't match this invitation/);
  });

  it("invitation tokens are non-guessable and the raw token never appears in API responses", async () => {
    const invitedEmail = "nonleak@example.com";
    let responseBody = "";
    const token = await captureInvitationToken(async () => {
      const res = await owner.post(`/api/workspaces/${workspaceId}/invitations`, {
        email: invitedEmail,
        roleKey: "MEMBER",
      });
      responseBody = res.body;
    });

    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(responseBody).not.toContain(token);
  });

  it("duplicate active workspace memberships are prevented", async () => {
    const invitedEmail = "dup-member@example.com";
    const token = await captureInvitationToken(() =>
      owner.post(`/api/workspaces/${workspaceId}/invitations`, {
        email: invitedEmail,
        roleKey: "MEMBER",
      }),
    );
    const invitee = await registerAndLogin(app, invitedEmail);
    await invitee.post(`/api/invitations/${token}/accept`);

    // Attempting to accept a fresh invitation to the same workspace for an
    // already-active member is idempotent, not a duplicate row.
    const token2 = await captureInvitationToken(() =>
      owner.post(`/api/workspaces/${workspaceId}/invitations`, {
        email: invitedEmail,
        roleKey: "ADMIN",
      }),
    );
    const res = await invitee.post(`/api/invitations/${token2}/accept`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe("You're already a member of this workspace.");

    const count = await prisma.workspaceMembership.count({
      where: { workspaceId, user: { email: invitedEmail } },
    });
    expect(count).toBe(1);
  });
});
