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

interface BoardColumn {
  id: string;
  name: string;
  category: string;
}

describe("Phase 5/6: activity feed + analytics", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let outsider: TestClient;

  let w1Id: string;
  let w2Id: string;
  let projectId: string;
  let categoryId: string;
  let otherProjectId: string;
  let otherCategoryId: string;
  let todoColumnId: string;
  let doneColumnId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "aa-owner@example.com");
    const w1 = await createWorkspaceAs(owner, "AA Workspace", "aa-workspace");
    w1Id = w1.id;

    const project = await createProjectAs(owner, w1Id, "AA Project");
    projectId = project.id;
    const category = await createCategoryAs(owner, w1Id, projectId, "Default");
    categoryId = category.id;
    const otherProject = await createProjectAs(owner, w1Id, "AA Project B");
    otherProjectId = otherProject.id;
    const otherCategory = await createCategoryAs(owner, w1Id, otherProjectId, "Default");
    otherCategoryId = otherCategory.id;

    const columnsRes = await owner.get(
      `/api/workspaces/${w1Id}/projects/${projectId}/categories/${categoryId}/columns`,
    );
    const columns = columnsRes.json().columns as BoardColumn[];
    todoColumnId = columns.find((c) => c.category === "todo")!.id;
    doneColumnId = columns.find((c) => c.category === "done")!.id;

    outsider = await registerAndLogin(app, "aa-outsider@example.com");
    const w2 = await createWorkspaceAs(outsider, "AA Workspace Two", "aa-workspace-two");
    w2Id = w2.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("creating a task records a task_created activity event", async () => {
    const taskRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectId}/categories/${categoryId}/tasks`, {
      title: "Write the release notes",
    });
    expect(taskRes.statusCode).toBe(201);
    const taskId = taskRes.json().task.id;

    const activityRes = await owner.get(`/api/workspaces/${w1Id}/projects/${projectId}/activity`);
    expect(activityRes.statusCode).toBe(200);
    const events = activityRes.json().events as Array<{ type: string; payload: Record<string, unknown> }>;
    const created = events.find((e) => e.type === "task_created" && e.payload.taskId === taskId);
    expect(created).toBeTruthy();
    expect(created?.payload.taskTitle).toBe("Write the release notes");
    expect(created?.payload.actorDisplayName).toBeTruthy();
  });

  it("moving a task to a different column records a task_moved activity event", async () => {
    const taskRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectId}/categories/${categoryId}/tasks`, {
      title: "Ship the feature",
      columnId: todoColumnId,
    });
    const task = taskRes.json().task;

    const moveRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectId}/categories/${categoryId}/tasks/${task.id}/move`, {
      version: task.version,
      columnId: doneColumnId,
    });
    expect(moveRes.statusCode).toBe(200);
    expect(moveRes.json().task.columnId).toBe(doneColumnId);
    // Phase 6: moving into a done-category column stamps completedAt.
    expect(moveRes.json().task.completedAt ?? null).not.toBeNull();

    const activityRes = await owner.get(`/api/workspaces/${w1Id}/projects/${projectId}/activity`);
    const events = activityRes.json().events as Array<{ type: string; payload: Record<string, unknown> }>;
    const moved = events.find((e) => e.type === "task_moved" && e.payload.taskId === task.id);
    expect(moved).toBeTruthy();
    expect(moved?.payload.fromColumnName).toBe("To Do");
    expect(moved?.payload.toColumnName).toBe("Done");
  });

  it("moving a task within the same column does NOT record a task_moved event", async () => {
    const taskRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectId}/categories/${categoryId}/tasks`, {
      title: "Reorder only",
      columnId: todoColumnId,
    });
    const task = taskRes.json().task;

    await owner.post(`/api/workspaces/${w1Id}/projects/${projectId}/categories/${categoryId}/tasks/${task.id}/move`, {
      version: task.version,
      columnId: todoColumnId,
    });

    const activityRes = await owner.get(`/api/workspaces/${w1Id}/projects/${projectId}/activity`);
    const events = activityRes.json().events as Array<{ type: string; payload: Record<string, unknown> }>;
    const moved = events.find((e) => e.type === "task_moved" && e.payload.taskId === task.id);
    expect(moved).toBeUndefined();
  });

  it("cross-workspace: an outsider gets 404 for the activity feed", async () => {
    const res = await outsider.get(`/api/workspaces/${w1Id}/projects/${projectId}/activity`);
    expect(res.statusCode).toBe(404);
  });

  it("cross-project: the activity feed is not reachable via a different project's URL", async () => {
    const res = await owner.get(`/api/workspaces/${w1Id}/projects/${otherProjectId}/activity`);
    const events = res.json().events as unknown[];
    // The endpoint itself resolves (otherProjectId is a real project the
    // caller can access), but it must never return P1's events.
    expect(res.statusCode).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("cross-workspace: an outsider gets 404 for the analytics endpoint", async () => {
    const res = await outsider.get(`/api/workspaces/${w1Id}/projects/${projectId}/analytics`);
    expect(res.statusCode).toBe(404);
  });

  it("cross-project: a non-existent project id under w1 returns 404 for analytics", async () => {
    const res = await owner.get(`/api/workspaces/${w1Id}/projects/00000000-0000-0000-0000-000000000000/analytics`);
    expect(res.statusCode).toBe(404);
  });

  it("returns real computed analytics for the project (owner has analytics.view)", async () => {
    const res = await owner.get(`/api/workspaces/${w1Id}/projects/${projectId}/analytics`);
    expect(res.statusCode).toBe(200);
    const { analytics } = res.json();
    expect(analytics.totals.totalTasks).toBeGreaterThan(0);
    expect(analytics.totals.completedTasks).toBeGreaterThanOrEqual(1);
    expect(typeof analytics.totals.completionPercentage).toBe("number");
    expect(Array.isArray(analytics.completedOverTime)).toBe(true);
    expect(analytics.completedOverTime.length).toBe(30);
    expect(analytics.health).toBeTruthy();
    expect(["on_track", "at_risk", "delayed"]).toContain(analytics.health.status);
    expect(typeof analytics.health.explanation).toBe("string");
    expect(analytics.health.explanation.length).toBeGreaterThan(0);
    expect(Array.isArray(analytics.recentActivity)).toBe(true);
  });

  it("MEMBER without analytics.view is forbidden from the analytics endpoint", async () => {
    const member = await inviteAndAccept(app, owner, w1Id, "aa-member@example.com", "MEMBER");
    const res = await member.get(`/api/workspaces/${w1Id}/projects/${projectId}/analytics`);
    expect(res.statusCode).toBe(403);
  });

  describe("Category-visibility filtering: private-category data must not leak into the project-wide activity feed or analytics", () => {
    let privateCategoryId: string;
    let privateTaskId: string;
    let outsiderMember: TestClient; // MEMBER of the workspace/project, but never added to the private category

    beforeAll(async () => {
      const privateCategory = await createCategoryAs(owner, w1Id, projectId, "Confidential", {
        visibility: "private",
      });
      privateCategoryId = privateCategory.id;

      const taskRes = await owner.post(
        `/api/workspaces/${w1Id}/projects/${projectId}/categories/${privateCategoryId}/tasks`,
        { title: "Secret analytics task", priority: "urgent" },
      );
      privateTaskId = taskRes.json().task.id;

      outsiderMember = await inviteAndAccept(app, owner, w1Id, "aa-outsider-member@example.com", "MEMBER");

      // MEMBER lacks `analytics.view` by default (see
      // packages/shared/src/roles.ts), so grant it directly on this
      // workspace's MEMBER role for this test only — this constructs the
      // one scenario that actually exercises the leak-proofing: a caller
      // who (a) can call the analytics endpoint at all, but (b) is ranked
      // below PROJECT_MANAGER and holds no CategoryMembership on the
      // private category, so their visible-category set must exclude it.
      const { prisma } = await import("../src/core/prisma.js");
      const memberRole = await prisma.role.findFirstOrThrow({ where: { workspaceId: w1Id, key: "MEMBER" } });
      await prisma.rolePermission.create({
        data: { roleId: memberRole.id, permission: "analytics.view" },
      });
    });

    it("activity feed: a caller without access to the private category never sees its task_created event", async () => {
      const ownerFeed = await owner.get(`/api/workspaces/${w1Id}/projects/${projectId}/activity`);
      const ownerEvents = ownerFeed.json().events as Array<{ payload: Record<string, unknown> }>;
      expect(ownerEvents.some((e) => e.payload.taskId === privateTaskId)).toBe(true);

      const outsiderFeed = await outsiderMember.get(`/api/workspaces/${w1Id}/projects/${projectId}/activity`);
      expect(outsiderFeed.statusCode).toBe(200);
      const outsiderEvents = outsiderFeed.json().events as Array<{ payload: Record<string, unknown> }>;
      expect(outsiderEvents.some((e) => e.payload.taskId === privateTaskId)).toBe(false);
    });

    it("category listing never leaks the private category's existence to a non-member", async () => {
      const categoriesRes = await outsiderMember.get(
        `/api/workspaces/${w1Id}/projects/${projectId}/categories`,
      );
      const visibleIds = (categoriesRes.json().categories as Array<{ id: string }>).map((c) => c.id);
      expect(visibleIds).not.toContain(privateCategoryId);
    });

    it("analytics: a private category's task never moves the aggregate totals or appears in recentActivity for a caller who can't see it", async () => {
      const ownerAnalytics = await owner.get(`/api/workspaces/${w1Id}/projects/${projectId}/analytics`);
      const ownerTotals = ownerAnalytics.json().analytics.totals as { totalTasks: number };
      const ownerRecentActivity = ownerAnalytics.json().analytics.recentActivity as Array<{
        payload: Record<string, unknown>;
      }>;
      // The owner (who created the category) does see it reflected.
      expect(ownerRecentActivity.some((e) => e.payload.taskId === privateTaskId)).toBe(true);

      const outsiderAnalytics = await outsiderMember.get(
        `/api/workspaces/${w1Id}/projects/${projectId}/analytics`,
      );
      expect(outsiderAnalytics.statusCode).toBe(200);
      const outsiderTotals = outsiderAnalytics.json().analytics.totals as { totalTasks: number };
      const outsiderRecentActivity = outsiderAnalytics.json().analytics.recentActivity as Array<{
        payload: Record<string, unknown>;
      }>;

      // The outsider's totals must be strictly less than the owner's
      // (missing at least the private category's task) and its
      // recentActivity must never surface the private task.
      expect(outsiderTotals.totalTasks).toBeLessThan(ownerTotals.totalTasks);
      expect(outsiderRecentActivity.some((e) => e.payload.taskId === privateTaskId)).toBe(false);
    });
  });
});
