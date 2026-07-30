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
  type TestClient,
} from "./helpers.js";

describe("Project/task/board RBAC (permission enforcement)", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;
  let projectId: string;
  let categoryId: string;
  let taskId: string;

  let viewer: TestClient;
  let clientUser: TestClient;
  let member: TestClient;
  let pm: TestClient;
  let admin: TestClient;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "owner@example.com");
    const ws = await createWorkspaceAs(owner, "PermCo", "perm-co");
    workspaceId = ws.id;

    const project = await createProjectAs(owner, workspaceId, "Perm Project");
    projectId = project.id;
    const category = await createCategoryAs(owner, workspaceId, projectId, "Default");
    categoryId = category.id;

    const taskRes = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`,
      { title: "Seed task" },
    );
    taskId = taskRes.json().task.id;

    viewer = await inviteAndAccept(app, owner, workspaceId, "viewer@example.com", "VIEWER");
    clientUser = await inviteAndAccept(app, owner, workspaceId, "client@example.com", "CLIENT");
    member = await inviteAndAccept(app, owner, workspaceId, "member@example.com", "MEMBER");
    pm = await inviteAndAccept(app, owner, workspaceId, "pm@example.com", "PROJECT_MANAGER");
    admin = await inviteAndAccept(app, owner, workspaceId, "admin@example.com", "ADMIN");

    // Give the CLIENT a ProjectMembership so their requests reach the
    // permission check (not blocked earlier at requireProjectAccess).
    const membersRes = await owner.get(`/api/workspaces/${workspaceId}/members`);
    const clientMemberId = (membersRes.json().members as Array<{ email: string; userId: string }>).find(
      (m) => m.email === "client@example.com",
    )!.userId;
    await owner.post(`/api/workspaces/${workspaceId}/projects/${projectId}/members`, {
      userId: clientMemberId,
    });
    // CLIENT always requires an explicit CategoryMembership row too
    // (mirrors CLIENT's "always requires ProjectMembership" rule one level
    // up) — without this, the CLIENT's requests would be blocked at
    // requireCategoryAccess (404) before ever reaching the permission
    // check this test exists to exercise (403).
    await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/members`,
      { userId: clientMemberId },
    );
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("VIEWER cannot create a task", async () => {
    const res = await viewer.post(`/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`, {
      title: "Nope",
    });
    expect(res.statusCode).toBe(403);
  });

  it("VIEWER cannot create a board column", async () => {
    const res = await viewer.post(`/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/columns`, {
      name: "Backlog",
      category: "todo",
    });
    expect(res.statusCode).toBe(403);
  });

  it("VIEWER cannot create a label or milestone", async () => {
    const labelRes = await viewer.post(`/api/workspaces/${workspaceId}/projects/${projectId}/labels`, {
      name: "x",
      color: "#123456",
    });
    expect(labelRes.statusCode).toBe(403);

    const milestoneRes = await viewer.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      { name: "M1" },
    );
    expect(milestoneRes.statusCode).toBe(403);
  });

  it("CLIENT (has project access) cannot create/edit/delete a task", async () => {
    const createRes = await clientUser.post(`/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`, {
      title: "Nope",
    });
    expect(createRes.statusCode).toBe(403);

    const editRes = await clientUser.patch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${taskId}`,
      { version: 1, title: "Hacked" },
    );
    expect(editRes.statusCode).toBe(403);

    const deleteRes = await clientUser.delete(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${taskId}`,
    );
    expect(deleteRes.statusCode).toBe(403);
  });

  it("MEMBER can create and edit tasks", async () => {
    const createRes = await member.post(`/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`, {
      title: "Member's task",
    });
    expect(createRes.statusCode).toBe(201);
    const memberTaskId = createRes.json().task.id;

    const editRes = await member.patch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${memberTaskId}`,
      { version: 1, title: "Member's edited task" },
    );
    expect(editRes.statusCode).toBe(200);
    expect(editRes.json().task.title).toBe("Member's edited task");
  });

  it("MEMBER cannot delete tasks", async () => {
    const res = await member.delete(`/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${taskId}`);
    expect(res.statusCode).toBe(403);
  });

  it("MEMBER cannot manage boards, labels, milestones, or dependencies", async () => {
    const columnRes = await member.post(`/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/columns`, {
      name: "Backlog",
      category: "todo",
    });
    expect(columnRes.statusCode).toBe(403);

    const labelRes = await member.post(`/api/workspaces/${workspaceId}/projects/${projectId}/labels`, {
      name: "y",
      color: "#654321",
    });
    expect(labelRes.statusCode).toBe(403);

    const milestoneRes = await member.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      { name: "M2" },
    );
    expect(milestoneRes.statusCode).toBe(403);

    const depRes = await member.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${taskId}/dependencies`,
      { blockingTaskId: taskId },
    );
    expect(depRes.statusCode).toBe(403);
  });

  it("PROJECT_MANAGER can manage boards, labels, milestones, and delete tasks (positive control)", async () => {
    const columnRes = await pm.post(`/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/columns`, {
      name: "Backlog",
      category: "todo",
    });
    expect(columnRes.statusCode).toBe(201);

    const labelRes = await pm.post(`/api/workspaces/${workspaceId}/projects/${projectId}/labels`, {
      name: "pm-label",
      color: "#00ff00",
    });
    expect(labelRes.statusCode).toBe(201);

    const milestoneRes = await pm.post(`/api/workspaces/${workspaceId}/projects/${projectId}/milestones`, {
      name: "PM Milestone",
    });
    expect(milestoneRes.statusCode).toBe(201);

    const deleteRes = await pm.delete(`/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${taskId}`);
    expect(deleteRes.statusCode).toBe(200);
  });

  it("ADMIN can create and archive a project (positive control)", async () => {
    const createRes = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
      name: "Admin's project",
    });
    expect(createRes.statusCode).toBe(201);
    const adminProjectId = createRes.json().project.id;

    const archiveRes = await admin.post(
      `/api/workspaces/${workspaceId}/projects/${adminProjectId}/archive`,
    );
    expect(archiveRes.statusCode).toBe(200);
    expect(archiveRes.json().project.archived).toBe(true);
  });

  it("ADMIN can unarchive a previously archived project", async () => {
    const createRes = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
      name: "Admin's unarchive project",
    });
    expect(createRes.statusCode).toBe(201);
    const adminProjectId = createRes.json().project.id;

    await admin.post(`/api/workspaces/${workspaceId}/projects/${adminProjectId}/archive`);

    const unarchiveRes = await admin.post(
      `/api/workspaces/${workspaceId}/projects/${adminProjectId}/unarchive`,
    );
    expect(unarchiveRes.statusCode).toBe(200);
    expect(unarchiveRes.json().project.archived).toBe(false);
    expect(unarchiveRes.json().project.archivedAt).toBeNull();
  });

  it("PROJECT_MANAGER cannot delete a project (project.delete stays Admin/Owner only)", async () => {
    const res = await pm.delete(`/api/workspaces/${workspaceId}/projects/${projectId}`);
    expect(res.statusCode).toBe(403);
  });

  it("deletes a project with a category, board column, and task without a 500 (FK-ordering regression)", async () => {
    const project = await createProjectAs(owner, workspaceId, "Deletable project");
    const category = await createCategoryAs(owner, workspaceId, project.id, "Default");

    const taskRes = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${project.id}/categories/${category.id}/tasks`,
      { title: "Task blocking cascade ordering" },
    );
    expect(taskRes.statusCode).toBe(201);

    const deleteRes = await owner.delete(`/api/workspaces/${workspaceId}/projects/${project.id}`);
    expect(deleteRes.statusCode).toBe(200);

    const getRes = await owner.get(`/api/workspaces/${workspaceId}/projects/${project.id}`);
    expect(getRes.statusCode).toBe(404);
  });
});
