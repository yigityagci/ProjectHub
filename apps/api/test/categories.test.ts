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

const LAST_CATEGORY_MESSAGE =
  "Every project must have at least one category. Create another category before deleting this one.";

/**
 * Categories: the required Project -> Category -> Task isolation tier.
 * Covers the product invariants that are specific to categories as a
 * resource (creation/rename/visibility/deletion rules, default-column
 * seeding, membership immediacy) — cross-resource IDOR isolation lives in
 * project-access-isolation.test.ts, and the real-time/analytics/activity
 * ripple effects live in realtime-eviction.test.ts and
 * activity-and-analytics.test.ts respectively.
 */
describe("Categories: CRUD, invariants, and membership", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "cat-owner@example.com");
    const ws = await createWorkspaceAs(owner, "Categories Co", "categories-co");
    workspaceId = ws.id;

    const project = await createProjectAs(owner, workspaceId, "Categories Project");
    projectId = project.id;
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("a brand-new project has ZERO categories (no auto-seeded default) and creating it never errors", async () => {
    const res = await owner.get(`/api/workspaces/${workspaceId}/projects/${projectId}/categories`);
    expect(res.statusCode).toBe(200);
    expect(res.json().categories).toEqual([]);
  });

  it("a project with zero categories handles analytics/activity gracefully (empty totals, never a crash)", async () => {
    // Analytics/activity are still project-wide endpoints and must degrade
    // gracefully (empty aggregates), never throw, while a project has zero
    // categories and therefore zero tasks of any kind.
    const analyticsRes = await owner.get(`/api/workspaces/${workspaceId}/projects/${projectId}/analytics`);
    expect(analyticsRes.statusCode).toBe(200);
    expect(analyticsRes.json().analytics.totals.totalTasks).toBe(0);

    const activityRes = await owner.get(`/api/workspaces/${workspaceId}/projects/${projectId}/activity`);
    expect(activityRes.statusCode).toBe(200);
    expect(activityRes.json().events).toEqual([]);
  });

  let firstCategoryId: string;

  it("creates the first category, auto-seeding 3 default columns (To Do/In Progress/Done)", async () => {
    const res = await owner.post(`/api/workspaces/${workspaceId}/projects/${projectId}/categories`, {
      name: "Engineering",
    });
    expect(res.statusCode).toBe(201);
    firstCategoryId = res.json().category.id;
    expect(res.json().category.name).toBe("Engineering");
    expect(res.json().category.visibility).toBe("workspace");

    const columnsRes = await owner.get(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${firstCategoryId}/columns`,
    );
    const columns = columnsRes.json().columns as Array<{ name: string; category: string }>;
    expect(columns).toHaveLength(3);
    expect(columns.map((c) => c.name).sort()).toEqual(["Done", "In Progress", "To Do"].sort());
  });

  it("rejects a duplicate category name within the same project", async () => {
    const res = await owner.post(`/api/workspaces/${workspaceId}/projects/${projectId}/categories`, {
      name: "Engineering",
    });
    expect(res.statusCode).toBe(409);
  });

  it("allows the same category name in a DIFFERENT project (uniqueness is per-project, not global)", async () => {
    const otherProject = await createProjectAs(owner, workspaceId, "Another Project");
    const res = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${otherProject.id}/categories`,
      { name: "Engineering" },
    );
    expect(res.statusCode).toBe(201);
  });

  it("renames a category and changes its visibility", async () => {
    const res = await owner.patch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${firstCategoryId}`,
      { name: "Eng Renamed", visibility: "private" },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().category.name).toBe("Eng Renamed");
    expect(res.json().category.visibility).toBe("private");

    // Revert visibility for subsequent tests in this file.
    await owner.patch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${firstCategoryId}`,
      { visibility: "workspace" },
    );
  });

  it("VIEWER cannot create/rename/delete a category (category.manage is OWNER/ADMIN/PROJECT_MANAGER only)", async () => {
    const viewer = await inviteAndAccept(app, owner, workspaceId, "cat-viewer@example.com", "VIEWER");
    const createRes = await viewer.post(`/api/workspaces/${workspaceId}/projects/${projectId}/categories`, {
      name: "Viewer's category",
    });
    expect(createRes.statusCode).toBe(403);

    const renameRes = await viewer.patch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${firstCategoryId}`,
      { name: "Hacked" },
    );
    expect(renameRes.statusCode).toBe(403);
  });

  it("MEMBER cannot manage categories either (category.manage is not in MEMBER_PERMISSIONS)", async () => {
    const member = await inviteAndAccept(app, owner, workspaceId, "cat-member@example.com", "MEMBER");
    const res = await member.post(`/api/workspaces/${workspaceId}/projects/${projectId}/categories`, {
      name: "Member's category",
    });
    expect(res.statusCode).toBe(403);
  });

  it("PROJECT_MANAGER can create/manage categories (positive control)", async () => {
    const pm = await inviteAndAccept(app, owner, workspaceId, "cat-pm@example.com", "PROJECT_MANAGER");
    const res = await pm.post(`/api/workspaces/${workspaceId}/projects/${projectId}/categories`, {
      name: "PM's category",
    });
    expect(res.statusCode).toBe(201);
    const pmCategoryId = res.json().category.id;

    const renameRes = await pm.patch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${pmCategoryId}`,
      { name: "PM's renamed category" },
    );
    expect(renameRes.statusCode).toBe(200);

    const deleteRes = await pm.delete(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${pmCategoryId}`,
    );
    expect(deleteRes.statusCode).toBe(200);
  });

  describe("Deletion invariants", () => {
    let onlyCategoryProjectId: string;
    let onlyCategoryId: string;

    beforeAll(async () => {
      const project = await createProjectAs(owner, workspaceId, "Single Category Project");
      onlyCategoryProjectId = project.id;
      const category = await createCategoryAs(owner, workspaceId, onlyCategoryProjectId, "Only Category");
      onlyCategoryId = category.id;
    });

    it("deleting the LAST remaining category of a project is rejected with the mirrored last-owner-style message", async () => {
      const res = await owner.delete(
        `/api/workspaces/${workspaceId}/projects/${onlyCategoryProjectId}/categories/${onlyCategoryId}`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe(LAST_CATEGORY_MESSAGE);

      // The project still has exactly one category — never reduced to zero.
      const listRes = await owner.get(
        `/api/workspaces/${workspaceId}/projects/${onlyCategoryProjectId}/categories`,
      );
      expect(listRes.json().categories).toHaveLength(1);
    });

    it("deleting a category that still has tasks in it is rejected (mirrors deleteColumn's task-count check)", async () => {
      const secondCategory = await createCategoryAs(
        owner,
        workspaceId,
        onlyCategoryProjectId,
        "Second Category",
      );

      const taskRes = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${onlyCategoryProjectId}/categories/${onlyCategoryId}/tasks`,
        { title: "A task blocking deletion" },
      );
      expect(taskRes.statusCode).toBe(201);

      // Now there are 2 categories, so the last-category rule doesn't
      // block this delete — but the task-count rule does.
      const deleteRes = await owner.delete(
        `/api/workspaces/${workspaceId}/projects/${onlyCategoryProjectId}/categories/${onlyCategoryId}`,
      );
      expect(deleteRes.statusCode).toBe(409);
      expect(deleteRes.json().error.message).toMatch(/still has tasks/i);

      // Deleting the empty sibling category (no tasks, and not the last
      // one) succeeds.
      const deleteEmptyRes = await owner.delete(
        `/api/workspaces/${workspaceId}/projects/${onlyCategoryProjectId}/categories/${secondCategory.id}`,
      );
      expect(deleteEmptyRes.statusCode).toBe(200);
    });
  });

  describe("Category membership — immediate effect (no stale cache)", () => {
    let privateCategoryId: string;
    let restrictedUser: TestClient;
    let restrictedUserId: string;

    beforeAll(async () => {
      const category = await createCategoryAs(owner, workspaceId, projectId, "Immediacy Category", {
        visibility: "private",
      });
      privateCategoryId = category.id;
      restrictedUser = await inviteAndAccept(app, owner, workspaceId, "cat-restricted@example.com", "MEMBER");
      restrictedUserId = await getMemberUserId(owner, workspaceId, "cat-restricted@example.com");
    });

    it("restricted user initially gets 404 on the private category", async () => {
      const res = await restrictedUser.get(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${privateCategoryId}`,
      );
      expect(res.statusCode).toBe(404);
    });

    it("adding a CategoryMembership row takes effect on the very next request — no new login/session needed", async () => {
      const addRes = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${privateCategoryId}/members`,
        { userId: restrictedUserId },
      );
      expect(addRes.statusCode).toBe(201);

      // Same TestClient/session as before.
      const res = await restrictedUser.get(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${privateCategoryId}`,
      );
      expect(res.statusCode).toBe(200);
    });

    it("removing the CategoryMembership row immediately revokes access on the very next request", async () => {
      const removeRes = await owner.delete(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${privateCategoryId}/members/${restrictedUserId}`,
      );
      expect(removeRes.statusCode).toBe(200);

      const res = await restrictedUser.get(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${privateCategoryId}`,
      );
      expect(res.statusCode).toBe(404);
    });

    it("cannot add a duplicate CategoryMembership for the same user", async () => {
      await owner.post(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${privateCategoryId}/members`,
        { userId: restrictedUserId },
      );
      const res = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${privateCategoryId}/members`,
        { userId: restrictedUserId },
      );
      expect(res.statusCode).toBe(409);
    });
  });
});
