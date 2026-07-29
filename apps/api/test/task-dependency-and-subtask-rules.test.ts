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

describe("Dependency cycle prevention and subtask nesting rules", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;
  let projectId: string;
  let categoryId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "owner@example.com");
    const ws = await createWorkspaceAs(owner, "Dep Co", "dep-co");
    workspaceId = ws.id;

    const project = await createProjectAs(owner, workspaceId, "Dep Project");
    projectId = project.id;
    const category = await createCategoryAs(owner, workspaceId, projectId, "Default");
    categoryId = category.id;
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  async function createTask(title: string): Promise<string> {
    const res = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`,
      { title },
    );
    return res.json().task.id;
  }

  it("rejects a self-referencing dependency with 422", async () => {
    const t1 = await createTask("Self dep task");
    const res = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${t1}/dependencies`,
      { blockingTaskId: t1 },
    );
    expect(res.statusCode).toBe(422);
  });

  it("rejects a dependency that would close a cycle with 409 DEPENDENCY_CYCLE", async () => {
    const t1 = await createTask("T1");
    const t2 = await createTask("T2");
    const t3 = await createTask("T3");

    // T1 blocks T2 (T2 depends on T1).
    const first = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${t2}/dependencies`,
      { blockingTaskId: t1 },
    );
    expect(first.statusCode).toBe(201);

    // T2 blocks T3 (T3 depends on T2). T1 -> T2 -> T3, no cycle yet.
    const second = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${t3}/dependencies`,
      { blockingTaskId: t2 },
    );
    expect(second.statusCode).toBe(201);

    // Now try: T3 blocks T1 (T1 depends on T3). This would close the loop
    // T1 -> T2 -> T3 -> T1.
    const cyclic = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${t1}/dependencies`,
      { blockingTaskId: t3 },
    );
    expect(cyclic.statusCode).toBe(409);
    expect(cyclic.json().error.code).toBe("DEPENDENCY_CYCLE");
  });

  it("cross-project dependency target returns 404", async () => {
    const otherProject = await createProjectAs(owner, workspaceId, "Other Dep Project");
    const otherCategory = await createCategoryAs(owner, workspaceId, otherProject.id, "Default");
    const t1 = await createTask("Local task");
    const otherTaskRes = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${otherProject.id}/categories/${otherCategory.id}/tasks`,
      { title: "Task in other project" },
    );
    const otherTaskId = otherTaskRes.json().task.id;

    const res = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${t1}/dependencies`,
      { blockingTaskId: otherTaskId },
    );
    expect(res.statusCode).toBe(404);
  });

  it("allows nesting a subtask exactly one level deep", async () => {
    const parent = await createTask("Parent task");
    const child = await createTask("Child task");

    const res = await owner.patch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${child}`,
      { version: 1, parentTaskId: parent },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().task.parentTaskId).toBe(parent);
  });

  it("rejects nesting a task under itself with 422", async () => {
    const t1 = await createTask("Self nest task");
    const res = await owner.patch(`/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${t1}`, {
      version: 1,
      parentTaskId: t1,
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects nesting a subtask under a task that is already a subtask (depth > 1)", async () => {
    const grandparent = await createTask("Grandparent");
    const parent = await createTask("Parent (will be a subtask)");
    const child = await createTask("Child (attempted grandchild)");

    const nestParent = await owner.patch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${parent}`,
      { version: 1, parentTaskId: grandparent },
    );
    expect(nestParent.statusCode).toBe(200);

    // parent is now a subtask (has a parentTaskId), so nesting child under it
    // would create a two-level hierarchy, which is not allowed.
    const nestChild = await owner.patch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${child}`,
      { version: 1, parentTaskId: parent },
    );
    expect(nestChild.statusCode).toBe(422);
  });

  it("rejects nesting a task under a parent that already has a subtask, if the nested task is itself already a parent", async () => {
    const grandparent = await createTask("Another grandparent");
    const existingChild = await createTask("Existing leaf child");
    await owner.patch(`/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${existingChild}`, {
      version: 1,
      parentTaskId: grandparent,
    });

    // A task that is itself already a parent of others cannot be nested
    // under anything (it must remain a top-level "parent" task).
    const someTask = await createTask("Has its own child");
    const itsChild = await createTask("Its child");
    await owner.patch(`/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${itsChild}`, {
      version: 1,
      parentTaskId: someTask,
    });

    const res = await owner.patch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${someTask}`,
      { version: 1, parentTaskId: grandparent },
    );
    expect(res.statusCode).toBe(422);
  });
});
