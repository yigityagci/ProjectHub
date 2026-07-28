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
  let otherProjectId: string;
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
    const otherProject = await createProjectAs(owner, w1Id, "AA Project B");
    otherProjectId = otherProject.id;

    const columnsRes = await owner.get(`/api/workspaces/${w1Id}/projects/${projectId}/columns`);
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
    const taskRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectId}/tasks`, {
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
    const taskRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectId}/tasks`, {
      title: "Ship the feature",
      columnId: todoColumnId,
    });
    const task = taskRes.json().task;

    const moveRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectId}/tasks/${task.id}/move`, {
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
    const taskRes = await owner.post(`/api/workspaces/${w1Id}/projects/${projectId}/tasks`, {
      title: "Reorder only",
      columnId: todoColumnId,
    });
    const task = taskRes.json().task;

    await owner.post(`/api/workspaces/${w1Id}/projects/${projectId}/tasks/${task.id}/move`, {
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
});
