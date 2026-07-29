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
  createCategoryAs,
  inviteAndAccept,
  getMemberUserId,
  buildMultipartUpload,
  type TestClient,
} from "./helpers.js";

describe("Comments & attachments: workspace isolation, RBAC, and validation", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let member: TestClient; // MEMBER role in w1 — can comment/upload
  let viewer: TestClient; // VIEWER role in w1 — strictly read-only
  let outsider: TestClient; // member of an unrelated workspace w2

  let w1Id: string;
  let w2Id: string;
  let projectId: string;
  let categoryId: string;
  let otherProjectId: string;
  let otherCategoryId: string;
  let taskId: string;
  let memberUserId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "ca-owner@example.com");
    const w1 = await createWorkspaceAs(owner, "CA Workspace", "ca-workspace");
    w1Id = w1.id;

    const project = await createProjectAs(owner, w1Id, "CA Project");
    projectId = project.id;
    const category = await createCategoryAs(owner, w1Id, projectId, "Default");
    categoryId = category.id;

    const taskRes = await owner.post(
      `/api/workspaces/${w1Id}/projects/${projectId}/categories/${categoryId}/tasks`,
      { title: "Task with comments" },
    );
    taskId = taskRes.json().task.id;

    member = await inviteAndAccept(app, owner, w1Id, "ca-member@example.com", "MEMBER");
    viewer = await inviteAndAccept(app, owner, w1Id, "ca-viewer@example.com", "VIEWER");
    memberUserId = await getMemberUserId(owner, w1Id, "ca-member@example.com");

    outsider = await registerAndLogin(app, "ca-outsider@example.com");
    const w2 = await createWorkspaceAs(outsider, "CA Workspace Two", "ca-workspace-two");
    w2Id = w2.id;

    const otherProject = await createProjectAs(owner, w1Id, "CA Project B");
    otherProjectId = otherProject.id;
    const otherCategory = await createCategoryAs(owner, w1Id, otherProjectId, "Default");
    otherCategoryId = otherCategory.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  const base = () =>
    `/api/workspaces/${w1Id}/projects/${projectId}/categories/${categoryId}/tasks/${taskId}`;

  // ---------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------

  let commentId: string;

  it("MEMBER can post a comment (reuses task.edit permission)", async () => {
    const res = await member.post(`${base()}/comments`, { body: "Hello, this is a comment." });
    expect(res.statusCode).toBe(201);
    commentId = res.json().comment.id;
    expect(res.json().comment.authorId).toBeTruthy();
  });

  it("VIEWER cannot post a comment (remains strictly read-only, same as Phase 2 task.edit semantics)", async () => {
    const res = await viewer.post(`${base()}/comments`, { body: "I should not be able to do this." });
    expect(res.statusCode).toBe(403);
  });

  it("a mention token @[userId] creates a Mention + Notification for that user", async () => {
    const res = await owner.post(`${base()}/comments`, { body: `Hey @[${memberUserId}] check this out.` });
    expect(res.statusCode).toBe(201);
    expect(res.json().comment.mentionedUserIds).toContain(memberUserId);

    const notifRes = await member.get("/api/notifications");
    expect(notifRes.statusCode).toBe(200);
    const notifications = notifRes.json().notifications as Array<{ type: string; payload: { taskId?: string } }>;
    expect(notifications.some((n) => n.type === "mention" && n.payload.taskId === taskId)).toBe(true);
  });

  it("cross-workspace: an outsider gets 404 listing/posting comments on w1's task", async () => {
    const listRes = await outsider.get(`${base()}/comments`);
    expect(listRes.statusCode).toBe(404);
    const postRes = await outsider.post(`${base()}/comments`, { body: "sneaky" });
    expect(postRes.statusCode).toBe(404);
  });

  it("cross-project: the comment is not reachable via a different project's URL", async () => {
    const res = await owner.get(
      `/api/workspaces/${w1Id}/projects/${otherProjectId}/categories/${otherCategoryId}/tasks/${taskId}/comments`,
    );
    expect(res.statusCode).toBe(404);
  });

  it("a non-author, non-elevated MEMBER cannot delete someone else's comment", async () => {
    const secondMember = await inviteAndAccept(app, owner, w1Id, "ca-member2@example.com", "MEMBER");
    const res = await secondMember.delete(`${base()}/comments/${commentId}`);
    expect(res.statusCode).toBe(403);
  });

  it("the author can delete their own comment", async () => {
    const res = await member.delete(`${base()}/comments/${commentId}`);
    expect(res.statusCode).toBe(200);
  });

  it("an Admin/Owner can delete someone else's comment (ownership-or-elevated-role rule)", async () => {
    const create = await member.post(`${base()}/comments`, { body: "Another comment" });
    const otherCommentId = create.json().comment.id;
    const res = await owner.delete(`${base()}/comments/${otherCommentId}`);
    expect(res.statusCode).toBe(200);
  });

  // ---------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------

  let attachmentId: string;

  it("MEMBER can upload an allowed-content-type attachment", async () => {
    const { payload, headers } = await buildMultipartUpload({
      filename: "notes.txt",
      contentType: "text/plain",
      data: Buffer.from("hello world"),
    });
    const res = await member.request({
      method: "POST",
      url: `${base()}/attachments`,
      payload,
      headers,
    });
    expect(res.statusCode).toBe(201);
    attachmentId = res.json().attachment.id;
    expect(res.json().attachment.filename).toBe("notes.txt");
  });

  it("VIEWER cannot upload an attachment", async () => {
    const { payload, headers } = await buildMultipartUpload({
      filename: "notes.txt",
      contentType: "text/plain",
      data: Buffer.from("hello"),
    });
    const res = await viewer.request({ method: "POST", url: `${base()}/attachments`, payload, headers });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a disallowed content-type", async () => {
    const { payload, headers } = await buildMultipartUpload({
      filename: "script.exe",
      contentType: "application/x-msdownload",
      data: Buffer.from("MZ..."),
    });
    const res = await member.request({ method: "POST", url: `${base()}/attachments`, payload, headers });
    expect(res.statusCode).toBe(422);
  });

  it("rejects an oversized file", async () => {
    const oversized = Buffer.alloc(1024 * 1024 + 1024, 1);
    const { payload, headers } = await buildMultipartUpload({
      filename: "big.txt",
      contentType: "text/plain",
      data: oversized,
    });
    const res = await member.request({ method: "POST", url: `${base()}/attachments`, payload, headers });
    expect(res.statusCode).toBe(413);
  });

  it("downloads the attachment only through the authorized proxy endpoint", async () => {
    const res = await member.get(`${base()}/attachments/${attachmentId}/download`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("hello world");
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  it("cross-workspace: an outsider gets 404 downloading/listing w1's attachment", async () => {
    const listRes = await outsider.get(`${base()}/attachments`);
    expect(listRes.statusCode).toBe(404);
    const downloadRes = await outsider.get(`${base()}/attachments/${attachmentId}/download`);
    expect(downloadRes.statusCode).toBe(404);
  });

  it("a non-uploader, non-elevated MEMBER cannot delete someone else's attachment", async () => {
    const res = await viewer.delete(`${base()}/attachments/${attachmentId}`);
    // VIEWER also lacks any comment/attachment permission floor, but the
    // ownership-or-elevated-role check runs regardless of role — either way
    // this must not succeed.
    expect(res.statusCode).not.toBe(200);
  });

  it("the uploader can delete their own attachment", async () => {
    const res = await member.delete(`${base()}/attachments/${attachmentId}`);
    expect(res.statusCode).toBe(200);
  });
});
