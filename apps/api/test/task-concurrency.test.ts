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
  type TestClient,
} from "./helpers.js";

describe("Optimistic concurrency on Task updates", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;
  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "owner@example.com");
    const ws = await createWorkspaceAs(owner, "Concurrency Co", "concurrency-co");
    workspaceId = ws.id;

    const project = await createProjectAs(owner, workspaceId, "Concurrency Project");
    projectId = project.id;

    const taskRes = await owner.post(`/api/workspaces/${workspaceId}/projects/${projectId}/tasks`, {
      title: "Race me",
    });
    taskId = taskRes.json().task.id;
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("two concurrent edits: the first (correct version) wins, the second (stale version) gets a 409 with currentTask, never a silent overwrite", async () => {
    // Both clients read the task at version 1.
    const readRes = await owner.get(`/api/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`);
    expect(readRes.json().task.version).toBe(1);

    // First writer succeeds, bumping the version to 2.
    const firstUpdate = await owner.patch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`,
      { version: 1, title: "Updated by first writer" },
    );
    expect(firstUpdate.statusCode).toBe(200);
    expect(firstUpdate.json().task.version).toBe(2);
    expect(firstUpdate.json().task.title).toBe("Updated by first writer");

    // Second writer still has the stale version (1) from their original read.
    const secondUpdate = await owner.patch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`,
      { version: 1, title: "Updated by second (stale) writer" },
    );
    expect(secondUpdate.statusCode).toBe(409);
    const body = secondUpdate.json();
    expect(body.error.code).toBe("VERSION_CONFLICT");
    expect(body.currentTask).toBeDefined();
    expect(body.currentTask.version).toBe(2);
    expect(body.currentTask.title).toBe("Updated by first writer");

    // The first writer's change was not overwritten.
    const finalRead = await owner.get(`/api/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`);
    expect(finalRead.json().task.title).toBe("Updated by first writer");
    expect(finalRead.json().task.version).toBe(2);
  });

  it("version is required on update — omitting it is a validation error, not a silent bypass", async () => {
    const res = await owner.patch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`,
      { title: "No version supplied" },
    );
    expect(res.statusCode).toBe(422);
  });

  it("move endpoint also enforces optimistic concurrency", async () => {
    const columnsRes = await owner.get(`/api/workspaces/${workspaceId}/projects/${projectId}/columns`);
    const columns = columnsRes.json().columns as Array<{ id: string; name: string }>;
    const inProgress = columns.find((c) => c.name === "In Progress")!;

    const taskRes = await owner.get(`/api/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`);
    const currentVersion = taskRes.json().task.version as number;

    const staleMove = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}/move`,
      { version: currentVersion - 1, columnId: inProgress.id },
    );
    expect(staleMove.statusCode).toBe(409);
    expect(staleMove.json().error.code).toBe("VERSION_CONFLICT");

    const validMove = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}/move`,
      { version: currentVersion, columnId: inProgress.id },
    );
    expect(validMove.statusCode).toBe(200);
    expect(validMove.json().task.columnId).toBe(inProgress.id);
  });
});
