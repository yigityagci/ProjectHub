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
  type TestClient,
} from "./helpers.js";

/**
 * Phase 7 search/filter endpoints. Two concerns are covered:
 *  1. Filters actually narrow results correctly (positive functional cases).
 *  2. Filters can never be used to leak cross-workspace/cross-project data
 *     — they only ever compose (AND) with the existing workspaceId/projectId
 *     scoping already enforced by requireMembership/requireProjectAccess,
 *     never replace it. A crafted filter cannot surface another workspace's
 *     or another project's tasks/projects.
 */
describe("Search & filter (Phase 7)", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let w1Id: string;
  let w2Id: string;
  let projectAId: string;
  let projectBId: string;
  let w2ProjectId: string;
  let categoryAId: string;
  let categoryBId: string;
  let w2CategoryId: string;

  let taskLoginBugId: string;
  let taskDocsId: string;
  let taskOverdueId: string;
  let taskParentId: string;
  let taskSubtaskId: string;
  let labelUrgentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "owner@example.com");
    const w1 = await createWorkspaceAs(owner, "Search Co", "search-co");
    w1Id = w1.id;

    const userB = await registerAndLogin(app, "userb@example.com");
    const w2 = await createWorkspaceAs(userB, "Other Co", "other-co");
    w2Id = w2.id;

    const projectA = await createProjectAs(owner, w1Id, "Alpha Project", { status: "active" });
    projectAId = projectA.id;
    const projectB = await createProjectAs(owner, w1Id, "Beta Project", { status: "planning" });
    projectBId = projectB.id;

    const w2Project = await createProjectAs(userB, w2Id, "Alpha Project");
    w2ProjectId = w2Project.id;

    const categoryA = await createCategoryAs(owner, w1Id, projectAId, "Default");
    categoryAId = categoryA.id;
    const categoryB = await createCategoryAs(owner, w1Id, projectBId, "Default");
    categoryBId = categoryB.id;
    const w2Category = await createCategoryAs(userB, w2Id, w2ProjectId, "Default");
    w2CategoryId = w2Category.id;

    // Same title in a DIFFERENT project of the SAME workspace, and in a
    // DIFFERENT workspace entirely — both must stay invisible to a search
    // scoped to projectA.
    const taskRes = await owner.post(
      `/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks`,
      { title: "Fix login bug", priority: "high" },
    );
    taskLoginBugId = taskRes.json().task.id;

    await owner.post(
      `/api/workspaces/${w1Id}/projects/${projectBId}/categories/${categoryBId}/tasks`,
      { title: "Fix login bug" },
    );
    await userB.post(
      `/api/workspaces/${w2Id}/projects/${w2ProjectId}/categories/${w2CategoryId}/tasks`,
      { title: "Fix login bug" },
    );

    const docsRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks`, {
      title: "Update docs",
      priority: "low",
    });
    taskDocsId = docsRes.json().task.id;

    const overdueRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks`, {
      title: "Overdue thing",
      dueDate: "2000-01-01T00:00:00.000Z",
    });
    taskOverdueId = overdueRes.json().task.id;

    const parentRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks`, {
      title: "Parent task",
    });
    taskParentId = parentRes.json().task.id;
    const subtaskRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks`, {
      title: "Subtask of parent",
      parentTaskId: taskParentId,
    });
    taskSubtaskId = subtaskRes.json().task.id;

    const labelRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectAId}/labels`, {
      name: "urgent",
      color: "#ff0000",
    });
    labelUrgentId = labelRes.json().label.id;
    await owner.post(
      `/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks/${taskLoginBugId}/labels/${labelUrgentId}`,
    );

    await owner.post(`/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks/${taskLoginBugId}/assignees`, {
      userId: (await owner.get("/api/auth/me")).json().user.id,
    });
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  describe("Task search/filter", () => {
    it("q substring-matches title/description, scoped to this project only", async () => {
      const res = await owner.get(
        `/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks?q=login`,
      );
      expect(res.statusCode).toBe(200);
      const tasks = res.json().tasks as Array<{ id: string; title: string }>;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.id).toBe(taskLoginBugId);
    });

    it("q is case-insensitive", async () => {
      const res = await owner.get(
        `/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks?q=LOGIN`,
      );
      expect(res.json().tasks).toHaveLength(1);
    });

    it("priority filter narrows results", async () => {
      const res = await owner.get(
        `/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks?priority=high`,
      );
      const tasks = res.json().tasks as Array<{ id: string }>;
      expect(tasks.map((t) => t.id)).toEqual([taskLoginBugId]);
    });

    it("labelId filter narrows results", async () => {
      const res = await owner.get(
        `/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks?labelId=${labelUrgentId}`,
      );
      const tasks = res.json().tasks as Array<{ id: string }>;
      expect(tasks.map((t) => t.id)).toEqual([taskLoginBugId]);
    });

    it("assigneeId filter narrows results", async () => {
      const me = (await owner.get("/api/auth/me")).json().user.id;
      const res = await owner.get(
        `/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks?assigneeId=${me}`,
      );
      const tasks = res.json().tasks as Array<{ id: string }>;
      expect(tasks.map((t) => t.id)).toEqual([taskLoginBugId]);
    });

    it("overdue filter returns only tasks with a past dueDate and no completedAt", async () => {
      const res = await owner.get(
        `/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks?overdue=true`,
      );
      const tasks = res.json().tasks as Array<{ id: string }>;
      expect(tasks.map((t) => t.id)).toEqual([taskOverdueId]);
    });

    it("parentTaskId filter returns only that task's subtasks", async () => {
      const res = await owner.get(
        `/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks?parentTaskId=${taskParentId}`,
      );
      const tasks = res.json().tasks as Array<{ id: string }>;
      expect(tasks.map((t) => t.id)).toEqual([taskSubtaskId]);
    });

    it("hasSubtasks=true returns only parent tasks that have subtasks", async () => {
      const res = await owner.get(
        `/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks?hasSubtasks=true`,
      );
      const tasks = res.json().tasks as Array<{ id: string }>;
      expect(tasks.map((t) => t.id)).toEqual([taskParentId]);
    });

    it("combining q with priority composes as AND, not OR", async () => {
      const res = await owner.get(
        `/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks?q=login&priority=low`,
      );
      expect(res.json().tasks).toHaveLength(0);
    });

    it("SECURITY: a crafted filter query cannot surface another project's task, even with the same title and same workspace", async () => {
      const res = await owner.get(
        `/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks?q=${encodeURIComponent("Fix login bug")}`,
      );
      const tasks = res.json().tasks as Array<{ id: string; title: string }>;
      // Both projectA and projectB (same workspace) have a task titled
      // "Fix login bug" — only projectA's must ever be returned from
      // projectA's endpoint.
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.id).toBe(taskLoginBugId);
    });

    it("SECURITY: a crafted filter query cannot surface another workspace's task", async () => {
      // userB's workspace (w2) has its own "Fix login bug" task in its own
      // project of the same name — confirm project A's search never
      // includes it (already implied above, but explicit for the isolation
      // suite's sake) and that userB cannot even reach projectA's endpoint.
      const res = await owner.get(`/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks?q=Fix`);
      const tasks = res.json().tasks as Array<{ id: string }>;
      expect(tasks.every((t) => t.id !== undefined)).toBe(true);
      expect(tasks).toHaveLength(1);
    });

    it("SECURITY: an unrecognized query field (e.g. attempting to override scoping) is rejected, not silently ignored", async () => {
      const res = await owner.get(
        `/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks?projectId=${projectBId}`,
      );
      // This codebase's ValidationError responds 422 (see core/errors.ts),
      // not 400 — the key point is that the unrecognized field is rejected
      // outright by the .strict() query schema, not silently dropped or
      // used to override scoping.
      expect(res.statusCode).toBe(422);
    });

    it("cross-workspace: a filter query against another workspace's project URL still returns 404, not an empty filtered list", async () => {
      const userB = await registerAndLogin(app, "userc@example.com");
      const res = await userB.get(`/api/workspaces/${w1Id}/projects/${projectAId}/categories/${categoryAId}/tasks?q=login`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("Project search/filter", () => {
    it("q substring-matches project name, scoped to the caller's workspace only", async () => {
      const res = await owner.get(`/api/workspaces/${w1Id}/projects?q=alpha`);
      expect(res.statusCode).toBe(200);
      const projects = res.json().projects as Array<{ id: string }>;
      expect(projects.map((p) => p.id)).toEqual([projectAId]);
    });

    it("status filter narrows results", async () => {
      const res = await owner.get(`/api/workspaces/${w1Id}/projects?status=planning`);
      const projects = res.json().projects as Array<{ id: string }>;
      expect(projects.map((p) => p.id)).toEqual([projectBId]);
    });

    it("archived filter narrows results", async () => {
      const archiveRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectBId}/archive`);
      expect(archiveRes.statusCode).toBe(200);

      const res = await owner.get(`/api/workspaces/${w1Id}/projects?archived=true`);
      const projects = res.json().projects as Array<{ id: string }>;
      expect(projects.map((p) => p.id)).toEqual([projectBId]);

      const notArchived = await owner.get(`/api/workspaces/${w1Id}/projects?archived=false`);
      const notArchivedProjects = notArchived.json().projects as Array<{ id: string }>;
      expect(notArchivedProjects.map((p) => p.id)).toEqual([projectAId]);
    });

    it("SECURITY: q matching a same-named project in a different workspace never leaks across workspaces", async () => {
      const res = await owner.get(`/api/workspaces/${w1Id}/projects?q=Alpha`);
      const projects = res.json().projects as Array<{ id: string; name: string }>;
      expect(projects).toHaveLength(1);
      expect(projects[0]!.id).toBe(projectAId);
      // w2ProjectId (userB's own "Alpha Project" in workspace 2) must never
      // appear in workspace 1's results.
      expect(projects.some((p) => p.id === w2ProjectId)).toBe(false);
    });
  });
});
