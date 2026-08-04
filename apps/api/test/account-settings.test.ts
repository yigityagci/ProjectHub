import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  freshClient,
  registerAndLogin,
  createWorkspaceAs,
  createProjectAs,
  createCategoryAs,
  inviteAndAccept,
  getMemberUserId,
  VALID_PASSWORD,
} from "./helpers.js";
import { prisma } from "../src/core/prisma.js";

const NEW_PASSWORD = "NewStr0ng!Passw0rd#";

describe("Account settings: profile/email/password/preferences", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("rejects a wrong currentPassword with 401 on both email/change and password/change, leaving both unchanged", async () => {
    const email = "wrong-pw@example.com";
    const client = await registerAndLogin(app, email);

    const emailRes = await client.post("/api/auth/email/change", {
      currentPassword: "TotallyWrongPassword1!",
      newEmail: "new-wrong-pw@example.com",
    });
    expect(emailRes.statusCode).toBe(401);

    const pwRes = await client.post("/api/auth/password/change", {
      currentPassword: "TotallyWrongPassword1!",
      newPassword: NEW_PASSWORD,
    });
    expect(pwRes.statusCode).toBe(401);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.email).toBe(email);

    // The original password still works for a fresh login.
    const loginRes = await freshClient(app).post("/api/auth/login", { email, password: VALID_PASSWORD });
    expect(loginRes.statusCode).toBe(200);
  });

  it("password change revokes every other session but keeps the caller's own session working", async () => {
    const email = "pw-change-sessions@example.com";
    const firstSession = await registerAndLogin(app, email);

    const secondSession = freshClient(app);
    const loginRes = await secondSession.post("/api/auth/login", { email, password: VALID_PASSWORD });
    expect(loginRes.statusCode).toBe(200);

    const meBefore = await secondSession.get("/api/auth/me");
    expect(meBefore.statusCode).toBe(200);

    const changeRes = await firstSession.post("/api/auth/password/change", {
      currentPassword: VALID_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(changeRes.statusCode).toBe(200);
    expect(changeRes.json()).toEqual({ ok: true });

    // The session that performed the change keeps working immediately.
    const meAfterFirst = await firstSession.get("/api/auth/me");
    expect(meAfterFirst.statusCode).toBe(200);

    // Every other session is revoked.
    const meAfterSecond = await secondSession.get("/api/auth/me");
    expect(meAfterSecond.statusCode).toBe(401);

    // The new password now works for a fresh login; the old one doesn't.
    const newLogin = await freshClient(app).post("/api/auth/login", { email, password: NEW_PASSWORD });
    expect(newLogin.statusCode).toBe(200);
    const oldLogin = await freshClient(app).post("/api/auth/login", { email, password: VALID_PASSWORD });
    expect(oldLogin.statusCode).toBe(401);
  });

  it("rejects changing email to one already owned by another user with 409", async () => {
    const takenEmail = "taken@example.com";
    await registerAndLogin(app, takenEmail);

    const client = await registerAndLogin(app, "wants-taken-email@example.com");
    const res = await client.post("/api/auth/email/change", {
      currentPassword: VALID_PASSWORD,
      newEmail: takenEmail,
    });
    expect(res.statusCode).toBe(409);

    const unchanged = await prisma.user.findUnique({ where: { email: "wants-taken-email@example.com" } });
    expect(unchanged).not.toBeNull();
  });

  it("rejects an unknown/extra key on PATCH /api/auth/me/preferences (mass-assignment via strict schema)", async () => {
    const client = await registerAndLogin(app, "prefs-mass-assignment@example.com");
    const res = await client.patch("/api/auth/me/preferences", {
      notifications: { mention: false },
      isPlatformAdmin: true,
    } as unknown as Record<string, unknown>);
    expect(res.statusCode).toBe(422);
  });

  it("suppresses notification creation entirely when the recipient has opted out (not just read-time filtering)", async () => {
    const owner = await registerAndLogin(app, "mention-owner@example.com");
    const ws = await createWorkspaceAs(owner, "Mention Workspace", "mention-workspace");
    const project = await createProjectAs(owner, ws.id, "Mention Project");
    const category = await createCategoryAs(owner, ws.id, project.id, "Default");

    const recipient = await inviteAndAccept(app, owner, ws.id, "mention-recipient@example.com", "MEMBER");
    const recipientUserId = await getMemberUserId(owner, ws.id, "mention-recipient@example.com");

    const prefsRes = await recipient.patch("/api/auth/me/preferences", {
      notifications: { mention: false },
    });
    expect(prefsRes.statusCode).toBe(200);
    expect(prefsRes.json().user.notifications.mention).toBe(false);

    const taskRes = await owner.post(
      `/api/workspaces/${ws.id}/projects/${project.id}/categories/${category.id}/tasks`,
      { title: "Mention target" },
    );
    const taskId = taskRes.json().task.id;

    const commentRes = await owner.post(
      `/api/workspaces/${ws.id}/projects/${project.id}/categories/${category.id}/tasks/${taskId}/comments`,
      { body: `Hey @[${recipientUserId}], take a look.` },
    );
    expect(commentRes.statusCode).toBe(201);

    const notifications = await prisma.notification.findMany({
      where: { recipientUserId, type: "mention" },
    });
    expect(notifications.length).toBe(0);
  });

  it("GET /api/auth/me returns default personalization preferences for a freshly created user", async () => {
    const client = await registerAndLogin(app, "personalization-defaults@example.com");
    const res = await client.get("/api/auth/me");
    expect(res.statusCode).toBe(200);
    expect(res.json().user.personalization).toEqual({
      defaultBoardView: "board",
      defaultLandingPage: "workspaces",
      compactMode: false,
      showKeyboardShortcutsReference: true,
    });
  });

  it("PATCH /api/auth/me/preferences round-trips all 4 personalization fields", async () => {
    const client = await registerAndLogin(app, "personalization-roundtrip@example.com");
    const res = await client.patch("/api/auth/me/preferences", {
      personalization: {
        defaultBoardView: "calendar",
        defaultLandingPage: "projects",
        compactMode: true,
        showKeyboardShortcutsReference: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.personalization).toEqual({
      defaultBoardView: "calendar",
      defaultLandingPage: "projects",
      compactMode: true,
      showKeyboardShortcutsReference: false,
    });

    // Durable — a fresh GET still reflects the write.
    const getRes = await client.get("/api/auth/me");
    expect(getRes.json().user.personalization).toEqual({
      defaultBoardView: "calendar",
      defaultLandingPage: "projects",
      compactMode: true,
      showKeyboardShortcutsReference: false,
    });
  });

  it("rejects an out-of-enum defaultBoardView on PATCH /api/auth/me/preferences", async () => {
    const client = await registerAndLogin(app, "personalization-invalid-enum@example.com");
    const res = await client.patch("/api/auth/me/preferences", {
      personalization: { defaultBoardView: "kanban" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("GET /api/auth/sessions returns exactly one row with current: true for a freshly logged-in single-session client", async () => {
    const client = await registerAndLogin(app, "single-session@example.com");
    const res = await client.get("/api/auth/sessions");
    expect(res.statusCode).toBe(200);
    const sessions = res.json().sessions as Array<{ current: boolean }>;
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.current).toBe(true);
  });
});
