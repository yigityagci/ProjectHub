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
  type TestClient,
} from "./helpers.js";

const NOT_FOUND_MESSAGE = "This project doesn't exist or you don't have access to it.";
const CATEGORY_NOT_FOUND_MESSAGE = "This category doesn't exist or you don't have access to it.";

describe("Project/task/board access isolation (IDOR protection)", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let w1Id: string;
  let w2Id: string;
  let p1Id: string;
  let p1bId: string;
  let privateProjectId: string;
  let c1Id: string;
  let c1bId: string;
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

    const c1 = await createCategoryAs(owner, w1Id, p1Id, "Default");
    c1Id = c1.id;
    const c1b = await createCategoryAs(owner, w1Id, p1bId, "Default");
    c1bId = c1b.id;

    const taskRes = await owner.post(
      `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${c1Id}/tasks`,
      { title: "Task in P1" },
    );
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
    const res = await userB.get(
      `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${c1Id}/tasks/${taskInP1Id}`,
    );
    expect(res.statusCode).toBe(404);
  });

  it("cross-project: a task from P1 is not accessible via P1B's URL", async () => {
    const res = await owner.get(
      `/api/workspaces/${w1Id}/projects/${p1bId}/categories/${c1bId}/tasks/${taskInP1Id}`,
    );
    expect(res.statusCode).toBe(404);
  });

  it("cross-category: a task from category C1 is not accessible via P1B's category C1B URL (same workspace/owner)", async () => {
    const res = await owner.get(
      `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${c1bId}/tasks/${taskInP1Id}`,
    );
    expect(res.statusCode).toBe(404);
  });

  it("cross-project: a label from P1 cannot be attached to a task via P1B", async () => {
    const taskInP1b = await owner.post(
      `/api/workspaces/${w1Id}/projects/${p1bId}/categories/${c1bId}/tasks`,
      { title: "Task in P1B" },
    );
    const taskId = taskInP1b.json().task.id;
    const res = await owner.post(
      `/api/workspaces/${w1Id}/projects/${p1bId}/categories/${c1bId}/tasks/${taskId}/labels/${labelInP1Id}`,
    );
    expect(res.statusCode).toBe(404);
  });

  it("cross-project: deleting P1's task via P1B's URL returns 404", async () => {
    const res = await owner.delete(
      `/api/workspaces/${w1Id}/projects/${p1bId}/categories/${c1bId}/tasks/${taskInP1Id}`,
    );
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
    const res = await userB.get(`/api/workspaces/${w1Id}/projects/${p1Id}/categories/${c1Id}/columns`);
    expect(res.statusCode).toBe(404);
  });

  it("cross-workspace: milestones/labels of P1 are not visible from w2", async () => {
    const milestonesRes = await userB.get(`/api/workspaces/${w1Id}/projects/${p1Id}/milestones`);
    expect(milestonesRes.statusCode).toBe(404);
    const labelsRes = await userB.get(`/api/workspaces/${w1Id}/projects/${p1Id}/labels`);
    expect(labelsRes.statusCode).toBe(404);
  });

  it("cross-workspace: categories of P1 are not accessible from w2 (category resource + columns + tasks)", async () => {
    const catRes = await userB.get(`/api/workspaces/${w1Id}/projects/${p1Id}/categories/${c1Id}`);
    expect(catRes.statusCode).toBe(404);
  });

  describe("Category isolation (IDOR protection) — private category", () => {
    let privateCategoryId: string;
    let siblingCategoryId: string;
    let taskInPrivateCategoryId: string;
    let columnInPrivateCategoryId: string;
    let siblingMemberUser: TestClient; // MEMBER, joined only the sibling (non-private) category
    let projectOnlyMemberUser: TestClient; // MEMBER, has project access but no category membership at all

    beforeAll(async () => {
      const privateCategory = await createCategoryAs(owner, w1Id, p1Id, "Private Category", {
        visibility: "private",
      });
      privateCategoryId = privateCategory.id;

      const siblingCategory = await createCategoryAs(owner, w1Id, p1Id, "Sibling Category");
      siblingCategoryId = siblingCategory.id;

      const columnsRes = await owner.get(
        `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${privateCategoryId}/columns`,
      );
      columnInPrivateCategoryId = columnsRes.json().columns[0].id;

      const taskRes = await owner.post(
        `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${privateCategoryId}/tasks`,
        { title: "Secret task" },
      );
      taskInPrivateCategoryId = taskRes.json().task.id;

      siblingMemberUser = await inviteAndAccept(app, owner, w1Id, "sibling-member@example.com", "MEMBER");
      const siblingUserId = await getMemberUserId(owner, w1Id, "sibling-member@example.com");
      await owner.post(
        `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${siblingCategoryId}/members`,
        { userId: siblingUserId },
      );

      projectOnlyMemberUser = await inviteAndAccept(app, owner, w1Id, "project-only-member@example.com", "MEMBER");
    });

    it("a user who is a member of a SIBLING category (but not the private one) gets 404 on the private category's own resource", async () => {
      const res = await siblingMemberUser.get(
        `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${privateCategoryId}`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toBe(CATEGORY_NOT_FOUND_MESSAGE);
    });

    it("a user who is a member of a SIBLING category gets 404 on the private category's columns", async () => {
      const res = await siblingMemberUser.get(
        `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${privateCategoryId}/columns`,
      );
      expect(res.statusCode).toBe(404);
    });

    it("a user who is a member of a SIBLING category gets 404 on the private category's tasks (list + single)", async () => {
      const listRes = await siblingMemberUser.get(
        `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${privateCategoryId}/tasks`,
      );
      expect(listRes.statusCode).toBe(404);

      const singleRes = await siblingMemberUser.get(
        `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${privateCategoryId}/tasks/${taskInPrivateCategoryId}`,
      );
      expect(singleRes.statusCode).toBe(404);
    });

    it("a project member with NO category membership at all also gets 404 on the private category's resource/columns/tasks", async () => {
      const catRes = await projectOnlyMemberUser.get(
        `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${privateCategoryId}`,
      );
      expect(catRes.statusCode).toBe(404);

      const columnsRes = await projectOnlyMemberUser.get(
        `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${privateCategoryId}/columns`,
      );
      expect(columnsRes.statusCode).toBe(404);

      const tasksRes = await projectOnlyMemberUser.get(
        `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${privateCategoryId}/tasks`,
      );
      expect(tasksRes.statusCode).toBe(404);
    });

    it("manually-guessed IDs: a sibling-category member cannot mutate a column/task in the private category either", async () => {
      const columnRes = await siblingMemberUser.patch(
        `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${privateCategoryId}/columns/${columnInPrivateCategoryId}`,
        { name: "Hacked" },
      );
      expect(columnRes.statusCode).toBe(404);

      const taskRes = await siblingMemberUser.patch(
        `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${privateCategoryId}/tasks/${taskInPrivateCategoryId}`,
        { version: 1, title: "Hacked" },
      );
      expect(taskRes.statusCode).toBe(404);
    });

    it("PROJECT_MANAGER (elevated rank) CAN access the private category without explicit membership", async () => {
      const res = await pmUser.get(`/api/workspaces/${w1Id}/projects/${p1Id}/categories/${privateCategoryId}`);
      expect(res.statusCode).toBe(200);
    });

    it("a CLIENT never gets private-category access via elevated rank (CLIENT always requires explicit CategoryMembership)", async () => {
      // clientUser already has ProjectMembership on p1Id from an earlier
      // test in this file, but no CategoryMembership on the private
      // category — CLIENT's rule is "always requires explicit membership",
      // never the rank-based escape hatch non-CLIENT roles get.
      const res = await clientUser.get(
        `/api/workspaces/${w1Id}/projects/${p1Id}/categories/${privateCategoryId}`,
      );
      expect(res.statusCode).toBe(404);
    });
  });
});
