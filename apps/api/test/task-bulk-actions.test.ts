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

interface ColumnRef {
  id: string;
  name: string;
}

interface TaskRef {
  id: string;
  version: number;
  columnId: string;
  position: number;
  completedAt: string | null;
}

describe("Bulk task actions", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;
  let projectId: string;
  let categoryId: string;
  let siblingCategoryId: string;
  let columns: ColumnRef[];
  let todo: ColumnRef;
  let inProgress: ColumnRef;
  let done: ColumnRef;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "bulk-owner@example.com");
    const ws = await createWorkspaceAs(owner, "Bulk Co", "bulk-co");
    workspaceId = ws.id;

    const project = await createProjectAs(owner, workspaceId, "Bulk Project");
    projectId = project.id;

    const category = await createCategoryAs(owner, workspaceId, projectId, "Main");
    categoryId = category.id;

    const sibling = await createCategoryAs(owner, workspaceId, projectId, "Sibling");
    siblingCategoryId = sibling.id;

    const columnsRes = await owner.get(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/columns`,
    );
    columns = columnsRes.json().columns as ColumnRef[];
    todo = columns.find((c) => c.name === "To Do")!;
    inProgress = columns.find((c) => c.name === "In Progress")!;
    done = columns.find((c) => c.name === "Done")!;
  });

  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  async function createTask(title: string, extra: Record<string, unknown> = {}): Promise<TaskRef> {
    const res = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`,
      { title, ...extra },
    );
    expect(res.statusCode).toBe(201);
    return res.json().task;
  }

  async function createTaskIn(cId: string, title: string, extra: Record<string, unknown> = {}): Promise<TaskRef> {
    const res = await owner.post(`/api/workspaces/${workspaceId}/projects/${projectId}/categories/${cId}/tasks`, {
      title,
      ...extra,
    });
    expect(res.statusCode).toBe(201);
    return res.json().task;
  }

  function bulkUrl(): string {
    return `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/bulk`;
  }

  async function getTask(taskId: string): Promise<TaskRef> {
    const res = await owner.get(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${taskId}`,
    );
    return res.json().task;
  }

  it("mixed success/failure batch on move: one success, one version conflict, one NOT_IN_CATEGORY", async () => {
    const a = await createTask("Move A");
    const b = await createTask("Move B");
    const sibling = await createTaskIn(siblingCategoryId, "Sibling task");

    // b is given a deliberately stale version (0, one below its actual
    // version of 1) so it produces a VERSION_CONFLICT alongside a's success
    // and the sibling task's NOT_IN_CATEGORY, all in a single batch.
    const res = await owner.post(bulkUrl(), {
      action: "move",
      taskIds: [a.id, b.id, sibling.id],
      versions: { [a.id]: a.version, [b.id]: b.version - 1, [sibling.id]: 1 },
      columnId: inProgress.id,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(3);
    expect(body.results.map((r: { taskId: string }) => r.taskId)).toEqual([a.id, b.id, sibling.id]);

    const aResult = body.results[0];
    const bResult = body.results[1];
    const siblingResult = body.results[2];

    expect(aResult.status).toBe("success");
    expect(aResult.task.columnId).toBe(inProgress.id);

    expect(bResult.status).toBe("error");
    expect(bResult.code).toBe("VERSION_CONFLICT");

    expect(siblingResult.status).toBe("error");
    expect(siblingResult.code).toBe("NOT_IN_CATEGORY");

    expect(body.summary).toEqual({ requested: 3, succeeded: 1, failed: 2 });

    // b did not actually move.
    const bFresh = await getTask(b.id);
    expect(bFresh.columnId).toBe(b.columnId);

    // the sibling task is untouched.
    const siblingCheck = await owner.get(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${siblingCategoryId}/tasks/${sibling.id}`,
    );
    expect(siblingCheck.json().task.columnId).toBe(sibling.columnId);
  });

  it("per-action-type permission denial: MEMBER (task.edit/task.assign, no task.delete) is denied delete but allowed setPriority", async () => {
    const member = await inviteAndAccept(app, owner, workspaceId, "bulk-member@example.com", "MEMBER");
    const t1 = await createTask("Perm task 1");
    const t2 = await createTask("Perm task 2");

    const priorityRes = await member.post(bulkUrl(), {
      action: "setPriority",
      taskIds: [t1.id, t2.id],
      versions: { [t1.id]: t1.version, [t2.id]: t2.version },
      priority: "high",
    });
    expect(priorityRes.statusCode).toBe(200);
    expect(priorityRes.json().summary.succeeded).toBe(2);

    const deleteRes = await member.post(bulkUrl(), {
      action: "delete",
      taskIds: [t1.id, t2.id],
    });
    expect(deleteRes.statusCode).toBe(403);
    expect(deleteRes.json().error.code).toBe("FORBIDDEN");

    // Nothing was deleted.
    const t1Fresh = await getTask(t1.id);
    expect(t1Fresh).toBeDefined();
  });

  it("a role with no task permissions is denied every bulk action type", async () => {
    const viewer = await inviteAndAccept(app, owner, workspaceId, "bulk-viewer@example.com", "VIEWER");
    const t1 = await createTask("Viewer denial task");

    const membersRes = await owner.get(`/api/workspaces/${workspaceId}/members`);
    const members = membersRes.json().members as Array<{ email: string; userId: string }>;
    const viewerId = members.find((m) => m.email === "bulk-viewer@example.com")!.userId;

    const moveRes = await viewer.post(bulkUrl(), {
      action: "move",
      taskIds: [t1.id],
      versions: { [t1.id]: t1.version },
      columnId: inProgress.id,
    });
    expect(moveRes.statusCode).toBe(403);

    const assignRes = await viewer.post(bulkUrl(), {
      action: "assign",
      taskIds: [t1.id],
      userId: viewerId,
    });
    expect(assignRes.statusCode).toBe(403);

    const deleteRes = await viewer.post(bulkUrl(), {
      action: "delete",
      taskIds: [t1.id],
    });
    expect(deleteRes.statusCode).toBe(403);
  });

  it("version conflict isolated: the other task still succeeds and its version increments by exactly 1", async () => {
    const a = await createTask("Isolated A");
    const b = await createTask("Isolated B");

    const res = await owner.post(bulkUrl(), {
      action: "setPriority",
      taskIds: [a.id, b.id],
      versions: { [a.id]: a.version, [b.id]: b.version - 1 },
      priority: "urgent",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const aResult = body.results.find((r: { taskId: string }) => r.taskId === a.id);
    const bResult = body.results.find((r: { taskId: string }) => r.taskId === b.id);

    expect(aResult.status).toBe("success");
    expect(aResult.task.version).toBe(a.version + 1);
    expect(aResult.task.priority).toBe("urgent");

    expect(bResult.status).toBe("error");
    expect(bResult.code).toBe("VERSION_CONFLICT");

    const bFresh = await getTask(b.id);
    expect(bFresh.version).toBe(b.version);
  });

  it("duplicate taskIds collapse to one result entry, action applied exactly once", async () => {
    const a = await createTask("Dup A");
    const b = await createTask("Dup B");

    const res = await owner.post(bulkUrl(), {
      action: "setPriority",
      taskIds: [a.id, a.id, b.id],
      versions: { [a.id]: a.version, [b.id]: b.version },
      priority: "low",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(2);
    expect(body.summary.requested).toBe(2);

    const aFresh = await getTask(a.id);
    expect(aFresh.version).toBe(a.version + 1);
  });

  it("empty taskIds is a validation error", async () => {
    const res = await owner.post(bulkUrl(), { action: "delete", taskIds: [] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it(".strict() rejects unknown top-level keys, wrong-variant fields, and unknown actions", async () => {
    const a = await createTask("Strict A");

    const unknownTopLevel = await owner.post(bulkUrl(), {
      action: "delete",
      taskIds: [a.id],
      extraField: "nope",
    });
    expect(unknownTopLevel.statusCode).toBe(422);

    const versionsOnDelete = await owner.post(bulkUrl(), {
      action: "delete",
      taskIds: [a.id],
      versions: { [a.id]: a.version },
    });
    expect(versionsOnDelete.statusCode).toBe(422);

    const unknownAction = await owner.post(bulkUrl(), {
      action: "comment",
      taskIds: [a.id],
    });
    expect(unknownAction.statusCode).toBe(422);
  });

  it("missing or incomplete versions on move/setPriority is a validation error, never a silent unversioned write", async () => {
    const a = await createTask("Version Required A");
    const b = await createTask("Version Required B");

    const missingVersions = await owner.post(bulkUrl(), {
      action: "setPriority",
      taskIds: [a.id, b.id],
      priority: "high",
    });
    expect(missingVersions.statusCode).toBe(422);

    const incompleteVersions = await owner.post(bulkUrl(), {
      action: "setPriority",
      taskIds: [a.id, b.id],
      versions: { [a.id]: a.version },
      priority: "high",
    });
    expect(incompleteVersions.statusCode).toBe(422);
  });

  it("taskIds longer than 100 is a validation error", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `fake-id-${i}`);
    const res = await owner.post(bulkUrl(), { action: "delete", taskIds: ids });
    expect(res.statusCode).toBe(422);
  });

  it("move positioning: 3 tasks land at the bottom of the target column, in request order, no duplicate positions", async () => {
    const existing = await createTask("Existing in target", { columnId: done.id });
    const a = await createTask("Pos A");
    const b = await createTask("Pos B");
    const c = await createTask("Pos C");

    const res = await owner.post(bulkUrl(), {
      action: "move",
      taskIds: [a.id, b.id, c.id],
      versions: { [a.id]: a.version, [b.id]: b.version, [c.id]: c.version },
      columnId: done.id,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const [aResult, bResult, cResult] = body.results;
    expect(aResult.status).toBe("success");
    expect(bResult.status).toBe("success");
    expect(cResult.status).toBe("success");

    const existingFresh = await getTask(existing.id);
    const positions = [aResult.task.position, bResult.task.position, cResult.task.position];
    expect(positions[0]).toBeGreaterThan(existingFresh.position);
    expect(positions[1]).toBeGreaterThan(positions[0]);
    expect(positions[2]).toBeGreaterThan(positions[1]);
    expect(new Set(positions).size).toBe(3);
  });

  it("moving into a done-category column sets completedAt; moving back out clears it", async () => {
    const a = await createTask("Done Cycle A");
    expect(a.completedAt).toBeNull();

    const intoRes = await owner.post(bulkUrl(), {
      action: "move",
      taskIds: [a.id],
      versions: { [a.id]: a.version },
      columnId: done.id,
    });
    expect(intoRes.statusCode).toBe(200);
    const intoResult = intoRes.json().results[0];
    expect(intoResult.status).toBe("success");
    expect(intoResult.task.completedAt).not.toBeNull();

    const outRes = await owner.post(bulkUrl(), {
      action: "move",
      taskIds: [a.id],
      versions: { [a.id]: intoResult.task.version },
      columnId: todo.id,
    });
    expect(outRes.statusCode).toBe(200);
    const outResult = outRes.json().results[0];
    expect(outResult.status).toBe("success");
    expect(outResult.task.completedAt).toBeNull();
  });

  it("bulk delete records one task_deleted activity event per directly-selected task", async () => {
    const a = await createTask("Bulk Deleted A");
    const b = await createTask("Bulk Deleted B");

    const res = await owner.post(bulkUrl(), {
      action: "delete",
      taskIds: [a.id, b.id],
    });
    expect(res.statusCode).toBe(200);

    const activityRes = await owner.get(`/api/workspaces/${workspaceId}/projects/${projectId}/activity`);
    const events = activityRes.json().events as Array<{ type: string; payload: Record<string, unknown> }>;
    const deletedForA = events.find((e) => e.type === "task_deleted" && e.payload.taskId === a.id);
    const deletedForB = events.find((e) => e.type === "task_deleted" && e.payload.taskId === b.id);
    expect(deletedForA).toBeTruthy();
    expect(deletedForA?.payload.taskTitle).toBe("Bulk Deleted A");
    expect(deletedForA?.payload.columnId).toBe(a.columnId);
    expect(deletedForB).toBeTruthy();
  });

  it("delete cascade: deleting a parent whose subtask was NOT selected removes the subtask too", async () => {
    const parent = await createTask("Cascade Parent");
    const subtaskRes = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`,
      { title: "Cascade Child", parentTaskId: parent.id },
    );
    expect(subtaskRes.statusCode).toBe(201);
    const subtask = subtaskRes.json().task;

    const res = await owner.post(bulkUrl(), {
      action: "delete",
      taskIds: [parent.id],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].status).toBe("success");
    expect(body.results[0].task).toBeNull();

    const subtaskCheck = await owner.get(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${subtask.id}`,
    );
    expect(subtaskCheck.statusCode).toBe(404);
  });

  it("delete: parent whose subtask WAS also selected in the batch reports success for both, no erroneous NOT_IN_CATEGORY", async () => {
    const parent = await createTask("Cascade Parent 2");
    const subtaskRes = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`,
      { title: "Cascade Child 2", parentTaskId: parent.id },
    );
    const subtask = subtaskRes.json().task;

    const res = await owner.post(bulkUrl(), {
      action: "delete",
      taskIds: [parent.id, subtask.id],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(2);
    for (const r of body.results) {
      expect(r.status).toBe("success");
    }
  });

  it("assign/unassign are idempotent: no duplicate rows, no NOT_FOUND-type error", async () => {
    const member = await inviteAndAccept(app, owner, workspaceId, "bulk-assignee@example.com", "MEMBER");
    const membersRes = await owner.get(`/api/workspaces/${workspaceId}/members`);
    const members = membersRes.json().members as Array<{ email: string; userId: string }>;
    const memberId = members.find((m) => m.email === "bulk-assignee@example.com")!.userId;
    void member;

    const a = await createTask("Idempotent A");
    const b = await createTask("Idempotent B");

    const assign1 = await owner.post(bulkUrl(), {
      action: "assign",
      taskIds: [a.id, b.id],
      userId: memberId,
    });
    expect(assign1.statusCode).toBe(200);
    expect(assign1.json().summary.succeeded).toBe(2);

    const assign2 = await owner.post(bulkUrl(), {
      action: "assign",
      taskIds: [a.id, b.id],
      userId: memberId,
    });
    expect(assign2.statusCode).toBe(200);
    expect(assign2.json().summary.succeeded).toBe(2);

    const aTaskRes = await owner.get(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${a.id}`,
    );
    expect(aTaskRes.json().task.assignees).toHaveLength(1);

    const unassign1 = await owner.post(bulkUrl(), {
      action: "unassign",
      taskIds: [a.id, b.id],
      userId: memberId,
    });
    expect(unassign1.statusCode).toBe(200);
    expect(unassign1.json().summary.succeeded).toBe(2);

    // Unassigning again (already not assigned) still succeeds for every task.
    const unassign2 = await owner.post(bulkUrl(), {
      action: "unassign",
      taskIds: [a.id, b.id],
      userId: memberId,
    });
    expect(unassign2.statusCode).toBe(200);
    expect(unassign2.json().summary.succeeded).toBe(2);
  });

  it("whole-request validation errors are not per-task: invalid columnId (different category) is a 422 for the whole request", async () => {
    const a = await createTask("Whole Req A");
    const siblingColumnsRes = await owner.get(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${siblingCategoryId}/columns`,
    );
    const siblingColumn = siblingColumnsRes.json().columns[0];

    const res = await owner.post(bulkUrl(), {
      action: "move",
      taskIds: [a.id],
      versions: { [a.id]: a.version },
      columnId: siblingColumn.id,
    });
    expect(res.statusCode).toBe(422);

    const aFresh = await getTask(a.id);
    expect(aFresh.version).toBe(a.version);
    expect(aFresh.columnId).toBe(a.columnId);
  });

  it("whole-request validation: assign to a non-member is a 422 and nothing is written", async () => {
    const a = await createTask("Whole Req Assign A");

    const res = await owner.post(bulkUrl(), {
      action: "assign",
      taskIds: [a.id],
      userId: "not-a-real-user-id",
    });
    expect(res.statusCode).toBe(422);

    const aTaskRes = await owner.get(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${a.id}`,
    );
    expect(aTaskRes.json().task.assignees).toHaveLength(0);
  });

  it("addLabel/removeLabel operate on the batch and are idempotent", async () => {
    const labelRes = await owner.post(`/api/workspaces/${workspaceId}/projects/${projectId}/labels`, {
      name: "Bulk Label",
      color: "#4287f5",
    });
    expect(labelRes.statusCode).toBe(201);
    const label = labelRes.json().label;

    const a = await createTask("Label A");
    const b = await createTask("Label B");

    const addRes = await owner.post(bulkUrl(), {
      action: "addLabel",
      taskIds: [a.id, b.id],
      labelId: label.id,
    });
    expect(addRes.statusCode).toBe(200);
    expect(addRes.json().summary.succeeded).toBe(2);

    // Idempotent re-add.
    const addAgainRes = await owner.post(bulkUrl(), {
      action: "addLabel",
      taskIds: [a.id, b.id],
      labelId: label.id,
    });
    expect(addAgainRes.statusCode).toBe(200);

    const aTaskRes = await owner.get(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${a.id}`,
    );
    expect(aTaskRes.json().task.labels).toHaveLength(1);

    const removeRes = await owner.post(bulkUrl(), {
      action: "removeLabel",
      taskIds: [a.id, b.id],
      labelId: label.id,
    });
    expect(removeRes.statusCode).toBe(200);
    expect(removeRes.json().summary.succeeded).toBe(2);
  });
});
