import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  registerAndLogin,
  freshClient,
  createWorkspaceAs,
  createProjectAs,
  createCategoryAs,
  inviteAndAccept,
  getMemberUserId,
  VALID_PASSWORD,
} from "./helpers.js";
import { prisma } from "../src/core/prisma.js";
import { issuePasswordResetToken } from "../src/auth/password-reset.service.js";

describe("Account deletion with history preservation (POST /api/auth/account/delete)", () => {
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

  it("rejects a wrong currentPassword with 401 and mutates nothing", async () => {
    const email = "wrong-password-delete@example.com";
    const client = await registerAndLogin(app, email);

    const res = await client.post("/api/auth/account/delete", {
      currentPassword: "TotallyWrongPassword1!",
    });
    expect(res.statusCode).toBe(401);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.status).toBe("active");
    expect(user?.email).toBe(email);
    expect(user?.deletedAt).toBeNull();

    // The account still works normally afterward.
    const meRes = await client.get("/api/auth/me");
    expect(meRes.statusCode).toBe(200);
  });

  it("blocks a sole workspace owner with 409 and leaves the account active", async () => {
    const email = "sole-owner-delete@example.com";
    const client = await registerAndLogin(app, email);
    const ws = await createWorkspaceAs(client, "Sole Owner Workspace", "sole-owner-workspace-delete");
    // `client` is the OWNER of `ws` (createWorkspace makes the caller owner)
    // and has no co-owner, so this must be blocked.
    void ws;

    const res = await client.post("/api/auth/account/delete", { currentPassword: VALID_PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/only owner of/i);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.status).toBe("active");
  });

  it("blocks the last remaining platform admin with 409 and leaves the account active", async () => {
    const email = "last-platform-admin-delete@example.com";
    const client = await registerAndLogin(app, email);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error("user not found");

    // No self-service "become platform admin" flow exists in this codebase
    // (see the D12 known limitation) — grant it directly for this test,
    // mirroring what POST /api/setup does for the very first user.
    await prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } });

    const res = await client.post("/api/auth/account/delete", { currentPassword: VALID_PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/only ProjectHub administrator/i);

    const reloaded = await prisma.user.findUnique({ where: { id: user.id } });
    expect(reloaded?.status).toBe("active");
  });

  it("full happy path: soft-deletes the account while preserving history everywhere else", async () => {
    const ownerEmail = "history-owner@example.com";
    const memberEmail = "history-member@example.com";

    const owner = await registerAndLogin(app, ownerEmail);
    const ws = await createWorkspaceAs(owner, "History Workspace", "history-workspace");
    const project = await createProjectAs(owner, ws.id, "History Project");
    const category = await createCategoryAs(owner, ws.id, project.id, "Default");

    const member = await inviteAndAccept(app, owner, ws.id, memberEmail, "MEMBER");
    const memberUserId = await getMemberUserId(owner, ws.id, memberEmail);

    // Add the member as an explicit category member too, so
    // CategoryMembership cleanup is exercised as well as
    // WorkspaceMembership/ProjectMembership.
    const addCategoryMemberRes = await owner.post(
      `/api/workspaces/${ws.id}/projects/${project.id}/categories/${category.id}/members`,
      { userId: memberUserId },
    );
    expect(addCategoryMemberRes.statusCode).toBe(201);

    const base = `/api/workspaces/${ws.id}/projects/${project.id}/categories/${category.id}`;

    const taskRes = await owner.post(`${base}/tasks`, { title: "History task" });
    expect(taskRes.statusCode).toBe(201);
    const taskId = taskRes.json().task.id;

    // The member gets assigned to the task and posts a comment — both must
    // survive the member's own future account deletion, unmodified.
    const assignRes = await member.post(`${base}/tasks/${taskId}/assignees`, { userId: memberUserId });
    expect(assignRes.statusCode).toBe(201);

    const commentRes = await member.post(`${base}/tasks/${taskId}/comments`, {
      body: "This is my comment, preserved for posterity.",
    });
    expect(commentRes.statusCode).toBe(201);

    const beforeUser = await prisma.user.findUnique({ where: { id: memberUserId } });
    if (!beforeUser) throw new Error("member user not found");
    const originalDisplayName = beforeUser.displayName;
    const originalEmail = beforeUser.email;
    expect(originalEmail).toBe(memberEmail);

    // A password-reset token requested BEFORE deletion must stop working
    // AFTER deletion (closes the consumePasswordResetToken GAP).
    const rawResetToken = await issuePasswordResetToken(memberEmail);
    expect(rawResetToken).not.toBeNull();

    // A second, independent logged-in session for the same member — must
    // also be revoked by the deletion.
    const secondMemberSession = freshClient(app);
    const secondLoginRes = await secondMemberSession.post("/api/auth/login", {
      email: memberEmail,
      password: VALID_PASSWORD,
    });
    expect(secondLoginRes.statusCode).toBe(200);

    // --- The actual deletion ---
    const deleteRes = await member.post("/api/auth/account/delete", { currentPassword: VALID_PASSWORD });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json()).toEqual({ ok: true });

    const afterUser = await prisma.user.findUnique({ where: { id: memberUserId } });
    if (!afterUser) throw new Error("member user disappeared");
    expect(afterUser.status).toBe("deleted");
    expect(afterUser.deletedAt).not.toBeNull();
    // displayName is NEVER modified by the deletion flow.
    expect(afterUser.displayName).toBe(originalDisplayName);
    expect(afterUser.email).not.toBe(originalEmail);
    expect(afterUser.email).toMatch(/^deleted-[0-9a-f-]{36}@deleted\.internal$/);

    // Membership rows are gone.
    const wsMemberships = await prisma.workspaceMembership.count({ where: { userId: memberUserId } });
    const projectMemberships = await prisma.projectMembership.count({ where: { userId: memberUserId } });
    const categoryMemberships = await prisma.categoryMembership.count({ where: { userId: memberUserId } });
    expect(wsMemberships).toBe(0);
    expect(projectMemberships).toBe(0);
    expect(categoryMemberships).toBe(0);

    // Every prior session (the one that performed the deletion, and the
    // independent second session) now gets 401.
    const meAfterDeletingSession = await member.get("/api/auth/me");
    expect(meAfterDeletingSession.statusCode).toBe(401);
    const meAfterSecondSession = await secondMemberSession.get("/api/auth/me");
    expect(meAfterSecondSession.statusCode).toBe(401);

    // Logging in again with the old password fails.
    const reloginRes = await freshClient(app).post("/api/auth/login", {
      email: memberEmail,
      password: VALID_PASSWORD,
    });
    expect(reloginRes.statusCode).toBe(401);

    // The outstanding password-reset token issued before deletion no longer
    // works afterward.
    const confirmRes = await freshClient(app).post("/api/auth/password-reset/confirm", {
      token: rawResetToken,
      password: "AnotherStr0ng!Passw0rd#",
    });
    expect(confirmRes.statusCode).toBe(404);

    // The original email address is immediately available for a fresh
    // registration.
    const newRegistrationClient = await registerAndLogin(app, originalEmail, "Reincarnated User");
    const newMe = await newRegistrationClient.get("/api/auth/me");
    expect(newMe.statusCode).toBe(200);
    expect(newMe.json().user.email).toBe(originalEmail);

    // A different, still-active user (the owner) fetching the task sees the
    // deleted member's original displayName on the assignee, flagged
    // isDeleted: true.
    const taskGetRes = await owner.get(`${base}/tasks/${taskId}`);
    expect(taskGetRes.statusCode).toBe(200);
    const assignees = taskGetRes.json().task.assignees as Array<{
      userId: string;
      displayName: string;
      isDeleted: boolean;
    }>;
    const deletedAssignee = assignees.find((a) => a.userId === memberUserId);
    expect(deletedAssignee).toBeDefined();
    expect(deletedAssignee?.displayName).toBe(originalDisplayName);
    expect(deletedAssignee?.isDeleted).toBe(true);

    // Same for the comment: authorDisplayName preserved, authorIsDeleted true.
    const commentsRes = await owner.get(`${base}/tasks/${taskId}/comments`);
    expect(commentsRes.statusCode).toBe(200);
    const comments = commentsRes.json().comments as Array<{
      authorId: string;
      authorDisplayName: string;
      authorIsDeleted: boolean;
    }>;
    const deletedComment = comments.find((c) => c.authorId === memberUserId);
    expect(deletedComment).toBeDefined();
    expect(deletedComment?.authorDisplayName).toBe(originalDisplayName);
    expect(deletedComment?.authorIsDeleted).toBe(true);

    // And the activity feed: actorIsDeleted computed off the live actorId FK.
    const activityRes = await owner.get(`/api/workspaces/${ws.id}/projects/${project.id}/activity?limit=50`);
    expect(activityRes.statusCode).toBe(200);
    const events = activityRes.json().events as Array<{ actorId: string; actorIsDeleted: boolean }>;
    const memberEvents = events.filter((e) => e.actorId === memberUserId);
    expect(memberEvents.length).toBeGreaterThan(0);
    for (const event of memberEvents) {
      expect(event.actorIsDeleted).toBe(true);
    }
  });
});
