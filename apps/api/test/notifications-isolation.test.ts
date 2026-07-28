import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  registerAndLogin,
  createWorkspaceAs,
  createProjectAs,
  inviteAndAccept,
  getMemberUserId,
  type TestClient,
} from "./helpers.js";

describe("Notifications: recipient-only access (IDOR protection)", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let recipient: TestClient;
  let stranger: TestClient;
  let workspaceId: string;
  let projectId: string;
  let taskId: string;
  let notificationId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "notif-owner@example.com");
    const ws = await createWorkspaceAs(owner, "Notif Workspace", "notif-workspace");
    workspaceId = ws.id;

    const project = await createProjectAs(owner, workspaceId, "Notif Project");
    projectId = project.id;

    const taskRes = await owner.post(`/api/workspaces/${workspaceId}/projects/${projectId}/tasks`, {
      title: "Assign me",
    });
    taskId = taskRes.json().task.id;

    recipient = await inviteAndAccept(app, owner, workspaceId, "notif-recipient@example.com", "MEMBER");
    const recipientUserId = await getMemberUserId(owner, workspaceId, "notif-recipient@example.com");

    // Triggers a `task_assigned` notification for `recipient`.
    const assignRes = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}/assignees`,
      { userId: recipientUserId },
    );
    expect(assignRes.statusCode).toBe(201);

    stranger = await registerAndLogin(app, "notif-stranger@example.com");
  });

  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("the recipient can list their own notification", async () => {
    const res = await recipient.get("/api/notifications");
    expect(res.statusCode).toBe(200);
    const notifications = res.json().notifications as Array<{ id: string; type: string }>;
    const taskAssigned = notifications.find((n) => n.type === "task_assigned");
    expect(taskAssigned).toBeTruthy();
    notificationId = taskAssigned!.id;
  });

  it("a stranger (not the recipient, not even a workspace member) gets 404 marking it read", async () => {
    const res = await stranger.post(`/api/notifications/${notificationId}/read`);
    expect(res.statusCode).toBe(404);
  });

  it("the workspace owner (not the recipient) also gets 404 marking someone else's notification read", async () => {
    const res = await owner.post(`/api/notifications/${notificationId}/read`);
    expect(res.statusCode).toBe(404);
  });

  it("a stranger's own notification list never contains the recipient's notification", async () => {
    const res = await stranger.get("/api/notifications");
    expect(res.statusCode).toBe(200);
    const ids = (res.json().notifications as Array<{ id: string }>).map((n) => n.id);
    expect(ids).not.toContain(notificationId);
  });

  it("the recipient can mark their own notification read", async () => {
    const res = await recipient.post(`/api/notifications/${notificationId}/read`);
    expect(res.statusCode).toBe(200);
    expect(res.json().notification.readAt).toBeTruthy();
  });

  it("mark-all-read only ever touches the caller's own notifications", async () => {
    const res = await stranger.post("/api/notifications/read-all");
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(0);
  });
});
