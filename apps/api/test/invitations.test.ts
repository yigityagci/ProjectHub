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
  inviteAndAccept,
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

  it("GET .../invitations lists only pending invitations, gated by member.invite or role.manage", async () => {
    // Uses its own fresh workspace (rather than the describe-wide
    // `workspaceId`) so this test's pending-invitation count isn't polluted
    // by other tests' still-pending invitations left over in the shared
    // workspace (e.g. the expired/mismatched-email cases above never
    // transition their invitation row out of "pending").
    const listWorkspace = await createWorkspaceAs(owner, "Invite List Co", "invite-list-co");
    const listWorkspaceId = listWorkspace.id;

    const pendingEmail = "list-pending@example.com";
    await captureInvitationToken(() =>
      owner.post(`/api/workspaces/${listWorkspaceId}/invitations`, {
        email: pendingEmail,
        roleKey: "MEMBER",
      }),
    );

    const acceptedEmail = "list-accepted@example.com";
    const acceptedToken = await captureInvitationToken(() =>
      owner.post(`/api/workspaces/${listWorkspaceId}/invitations`, {
        email: acceptedEmail,
        roleKey: "MEMBER",
      }),
    );
    const acceptedInvitee = await registerAndLogin(app, acceptedEmail);
    await acceptedInvitee.post(`/api/invitations/${acceptedToken}/accept`);

    const revokedEmail = "list-revoked@example.com";
    const revokedToken = await captureInvitationToken(() =>
      owner.post(`/api/workspaces/${listWorkspaceId}/invitations`, {
        email: revokedEmail,
        roleKey: "MEMBER",
      }),
    );
    const revokedInvitation = await prisma.invitation.findFirst({ where: { email: revokedEmail } });
    await owner.post(`/api/workspaces/${listWorkspaceId}/invitations/${revokedInvitation!.id}/revoke`);
    expect(revokedToken).toBeTruthy();

    // Owner (has both member.invite and role.manage) sees only the pending one.
    const listRes = await owner.get(`/api/workspaces/${listWorkspaceId}/invitations`);
    expect(listRes.statusCode).toBe(200);
    const invitations = listRes.json().invitations as Array<{
      id: string;
      email: string;
      roleKey: string;
      roleName: string;
      status: string;
      expiresAt: string;
      createdAt: string;
    }>;
    expect(invitations).toHaveLength(1);
    expect(invitations[0]!.email).toBe(pendingEmail);
    expect(invitations[0]!.roleKey).toBe("MEMBER");
    expect(invitations[0]!.status).toBe("pending");
    expect(invitations[0]!.expiresAt).toBeTruthy();
    expect(invitations[0]!.createdAt).toBeTruthy();

    // A plain MEMBER (neither member.invite nor role.manage) is forbidden.
    const plainMember = await inviteAndAccept(
      app,
      owner,
      listWorkspaceId,
      "plain-member@example.com",
      "MEMBER",
    );
    const forbiddenRes = await plainMember.get(`/api/workspaces/${listWorkspaceId}/invitations`);
    expect(forbiddenRes.statusCode).toBe(403);

    // A PROJECT_MANAGER (has member.invite but not role.manage) is allowed.
    const pm = await inviteAndAccept(
      app,
      owner,
      listWorkspaceId,
      "pm-lister@example.com",
      "PROJECT_MANAGER",
    );
    const pmRes = await pm.get(`/api/workspaces/${listWorkspaceId}/invitations`);
    expect(pmRes.statusCode).toBe(200);
  });
});
