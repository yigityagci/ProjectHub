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

const NOT_FOUND_MESSAGE = "This project doesn't exist or you don't have access to it.";

describe("Project/task/board access isolation (IDOR protection)", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let w1Id: string;
  let w2Id: string;
  let p1Id: string;
  let p1bId: string;
  let privateProjectId: string;
  let taskInP1Id: string;
  let labelInP1Id: string;

  let userB: TestClient; // member of w2 only
  let clientUser: TestClient; // CLIENT in w1, no project membership initially
  let memberUser: TestClient; // MEMBER in w1, no project membership
  let pmUser: TestClient; // PROJECT_MANAGER in w1, no project membership

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "owner@example.com");
    const w1 = await createWorkspaceAs(owner, "Workspace One", "workspace-one");
    w1Id = w1.id;

    userB = await registerAndLogin(app, "userb@example.com");
    const w2 = await createWorkspaceAs(userB, "Workspace Two", "workspace-two");
    w2Id = w2.id;

    const p1 = await createProjectAs(owner, w1Id, "Project One");
    p1Id = p1.id;
    const p1b = await createProjectAs(owner, w1Id, "Project One B");
    p1bId = p1b.id;

    const privateProject = await createProjectAs(owner, w1Id, "Secret Project", { visibility: "private" });
    privateProjectId = privateProject.id;

    const taskRes = await owner.post(`/api/workspaces/${w1Id}/projects/${p1Id}/tasks`, {
      title: "Task in P1",
    });
    taskInP1Id = taskRes.json().task.id;

    const labelRes = await owner.post(`/api/workspaces/${w1Id}/projects/${p1Id}/labels`, {
      name: "urgent",
      color: "#ff0000",
    });
    labelInP1Id = labelRes.json().label.id;

    clientUser = await inviteAndAccept(app, owner, w1Id, "client@example.com", "CLIENT");
    memberUser = await inviteAndAccept(app, owner, w1Id, "member@example.com", "MEMBER");
    pmUser = await inviteAndAccept(app, owner, w1Id, "pm@example.com", "PROJECT_MANAGER");
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("cross-workspace: a member of w2 gets 404 for a project in w1", async () => {
    const res = await userB.get(`/api/workspaces/${w1Id}/projects/${p1Id}`);
    expect(res.statusCode).toBe(404);
  });

  it("cross-workspace: a member of w2 gets 404 for a task in w1", async () => {
    const res = await userB.get(`/api/workspaces/${w1Id}/projects/${p1Id}/tasks/${taskInP1Id}`);
    expect(res.statusCode).toBe(404);
  });

  it("cross-project: a task from P1 is not accessible via P1B's URL", async () => {
    const res = await owner.get(`/api/workspaces/${w1Id}/projects/${p1bId}/tasks/${taskInP1Id}`);
    expect(res.statusCode).toBe(404);
  });

  it("cross-project: a label from P1 cannot be attached to a task via P1B", async () => {
    const taskInP1b = await owner.post(`/api/workspaces/${w1Id}/projects/${p1bId}/tasks`, {
      title: "Task in P1B",
    });
    const taskId = taskInP1b.json().task.id;
    const res = await owner.post(
      `/api/workspaces/${w1Id}/projects/${p1bId}/tasks/${taskId}/labels/${labelInP1Id}`,
    );
    expect(res.statusCode).toBe(404);
  });

  it("cross-project: deleting P1's task via P1B's URL returns 404", async () => {
    const res = await owner.delete(`/api/workspaces/${w1Id}/projects/${p1bId}/tasks/${taskInP1Id}`);
    expect(res.statusCode).toBe(404);
  });

  it("CLIENT without a ProjectMembership row gets 404 for a workspace-visible project", async () => {
    const res = await clientUser.get(`/api/workspaces/${w1Id}/projects/${p1Id}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe(NOT_FOUND_MESSAGE);
  });

  it("CLIENT's project list is empty until granted a ProjectMembership", async () => {
    const res = await clientUser.get(`/api/workspaces/${w1Id}/projects`);
    expect(res.statusCode).toBe(200);
    expect(res.json().projects).toHaveLength(0);
  });

  it("CLIENT gains access once granted a ProjectMembership on P1", async () => {
    const clientUserId = await getMemberUserId(owner, w1Id, "client@example.com");
    const addRes = await owner.post(`/api/workspaces/${w1Id}/projects/${p1Id}/members`, {
      userId: clientUserId,
    });
    expect(addRes.statusCode).toBe(201);

    const res = await clientUser.get(`/api/workspaces/${w1Id}/projects/${p1Id}`);
    expect(res.statusCode).toBe(200);

    // Still 404 for the OTHER project they aren't a member of.
    const other = await clientUser.get(`/api/workspaces/${w1Id}/projects/${p1bId}`);
    expect(other.statusCode).toBe(404);
  });

  it("MEMBER (rank below PROJECT_MANAGER) without ProjectMembership gets 404 for a private project", async () => {
    const res = await memberUser.get(`/api/workspaces/${w1Id}/projects/${privateProjectId}`);
    expect(res.statusCode).toBe(404);
  });

  it("PROJECT_MANAGER (elevated rank) can access a private project without ProjectMembership", async () => {
    const res = await pmUser.get(`/api/workspaces/${w1Id}/projects/${privateProjectId}`);
    expect(res.statusCode).toBe(200);
  });

  it("cross-workspace: columns of P1 are not visible from w2", async () => {
    const res = await userB.get(`/api/workspaces/${w1Id}/projects/${p1Id}/columns`);
    expect(res.statusCode).toBe(404);
  });

  it("cross-workspace: milestones/labels of P1 are not visible from w2", async () => {
    const milestonesRes = await userB.get(`/api/workspaces/${w1Id}/projects/${p1Id}/milestones`);
    expect(milestonesRes.statusCode).toBe(404);
    const labelsRes = await userB.get(`/api/workspaces/${w1Id}/projects/${p1Id}/labels`);
    expect(labelsRes.statusCode).toBe(404);
  });
});
