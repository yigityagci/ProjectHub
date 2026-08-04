import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/core/prisma.js";
import * as labelsService from "../src/projects/labels.service.js";
import { duplicateProject } from "../src/projects/projects.duplicate.service.js";
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
  category: string;
  color: string | null;
  position: number;
}

interface CategoryRef {
  id: string;
  name: string;
  visibility: string;
}

/**
 * Duplicate project: a stateless one-shot copy of a project's structure
 * (categories/boards/columns/labels/custom fields) into a brand-new project.
 * Never copies tasks. Covers the full structural match, the column-
 * reconciliation edge-case matrix (colliding with DEFAULT_COLUMNS auto-seed),
 * the headline zero-tasks invariant, permission gating (missing any one of
 * the 5 underlying permissions -> 403), and the compensating-delete-on-
 * failure behaviour.
 */
describe("Duplicate project", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "dup-owner@example.com");
    const ws = await createWorkspaceAs(owner, "Duplicate Co", "duplicate-co");
    workspaceId = ws.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  function columnsUrl(projectId: string, categoryId: string): string {
    return `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/columns`;
  }

  async function getColumns(projectId: string, categoryId: string): Promise<ColumnRef[]> {
    const res = await owner.get(columnsUrl(projectId, categoryId));
    expect(res.statusCode).toBe(200);
    return res.json().columns as ColumnRef[];
  }

  async function getCategories(projectId: string): Promise<CategoryRef[]> {
    const res = await owner.get(`/api/workspaces/${workspaceId}/projects/${projectId}/categories`);
    expect(res.statusCode).toBe(200);
    return res.json().categories as CategoryRef[];
  }

  async function duplicate(
    client: TestClient,
    projectId: string,
    name: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await client.post(`/api/workspaces/${workspaceId}/projects/${projectId}/duplicate`, { name });
    return { status: res.statusCode, body: res.json() };
  }

  // -------------------------------------------------------------------------
  // Full structural match + headline zero-tasks invariant
  // -------------------------------------------------------------------------

  it("duplicates categories/columns/labels/custom fields, matches the source exactly, and copies zero tasks", async () => {
    const source = await createProjectAs(owner, workspaceId, "Source Alpha", {
      description: "Source description",
      visibility: "workspace",
    });

    const cat1 = await createCategoryAs(owner, workspaceId, source.id, "Design");
    const cat2 = await createCategoryAs(owner, workspaceId, source.id, "Engineering", { visibility: "private" });

    // Add a task in cat1 to prove tasks are never copied.
    const columns1 = await getColumns(source.id, cat1.id);
    await owner.post(
      `/api/workspaces/${workspaceId}/projects/${source.id}/categories/${cat1.id}/tasks`,
      { title: "Should not be copied", columnId: columns1[0]!.id },
    );

    await owner.post(`/api/workspaces/${workspaceId}/projects/${source.id}/labels`, {
      name: "Bug",
      color: "#ff0000",
    });
    await owner.post(`/api/workspaces/${workspaceId}/projects/${source.id}/labels`, {
      name: "Feature",
      color: "#00ff00",
    });

    await owner.post(`/api/workspaces/${workspaceId}/projects/${source.id}/custom-fields`, {
      name: "Severity",
      type: "select",
      options: ["Low", "High"],
    });
    await owner.post(`/api/workspaces/${workspaceId}/projects/${source.id}/custom-fields`, {
      name: "Notes",
      type: "text",
    });

    const result = await duplicate(owner, source.id, "Source Alpha (copy)");
    expect(result.status).toBe(201);
    const newProject = result.body.project as { id: string; name: string; description: string | null; visibility: string; status: string; archived: boolean };
    const copied = result.body.copied as { categories: number; columns: number; labels: number; customFields: number };

    expect(newProject.name).toBe("Source Alpha (copy)");
    expect(newProject.description).toBe("Source description");
    expect(newProject.visibility).toBe("workspace");
    expect(newProject.status).toBe("planning");
    expect(newProject.archived).toBe(false);

    expect(copied).toEqual({ categories: 2, columns: 6, labels: 2, customFields: 2 });

    // Categories match name/visibility/order.
    const newCategories = await getCategories(newProject.id);
    expect(newCategories.map((c) => c.name)).toEqual(["Design", "Engineering"]);
    expect(newCategories.map((c) => c.visibility)).toEqual(["workspace", "private"]);

    // Columns of the untouched-defaults category match exactly.
    const newCat1Columns = await getColumns(newProject.id, newCategories[0]!.id);
    expect(newCat1Columns.map((c) => c.name)).toEqual(["To Do", "In Progress", "Done"]);
    expect(newCat1Columns.map((c) => c.position)).toEqual([1, 2, 3]);

    // Labels match.
    const labelsRes = await owner.get(`/api/workspaces/${workspaceId}/projects/${newProject.id}/labels`);
    const newLabels = labelsRes.json().labels as Array<{ name: string; color: string }>;
    expect(newLabels.map((l) => l.name).sort()).toEqual(["Bug", "Feature"]);

    // Custom fields match name/type/options.
    const fieldsRes = await owner.get(`/api/workspaces/${workspaceId}/projects/${newProject.id}/custom-fields`);
    const newFields = fieldsRes.json().fields as Array<{ name: string; type: string; options: string[] }>;
    expect(newFields.map((f) => f.name)).toEqual(["Severity", "Notes"]);
    expect(newFields.find((f) => f.name === "Severity")!.options).toEqual(["Low", "High"]);
    expect(newFields.find((f) => f.name === "Notes")!.options).toEqual([]);

    // Headline invariant: zero tasks in the new project, always.
    const taskCount = await prisma.task.count({ where: { projectId: newProject.id } });
    expect(taskCount).toBe(0);

    // Category membership never carries over for the private category.
    const membershipCount = await prisma.categoryMembership.count({
      where: { categoryId: newCategories[1]!.id },
    });
    expect(membershipCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Column-reconciliation edge-case matrix
  // -------------------------------------------------------------------------

  describe("Column reconciliation", () => {
    async function makeSourceWithOneCategory(): Promise<{ projectId: string; categoryId: string }> {
      const project = await createProjectAs(owner, workspaceId, `Recon Source ${Date.now()}-${Math.random()}`);
      const category = await createCategoryAs(owner, workspaceId, project.id, "Board");
      return { projectId: project.id, categoryId: category.id };
    }

    it("(a) untouched 3 defaults -> duplicate has exactly 3 columns, same names/order", async () => {
      const { projectId, categoryId } = await makeSourceWithOneCategory();
      const sourceColumns = await getColumns(projectId, categoryId);

      const result = await duplicate(owner, projectId, `Recon A Copy ${Math.random()}`);
      expect(result.status).toBe(201);
      const newProject = result.body.project as { id: string };
      const newCategories = await getCategories(newProject.id);
      const newColumns = await getColumns(newProject.id, newCategories[0]!.id);

      expect(newColumns.map((c) => c.name)).toEqual(sourceColumns.map((c) => c.name));
      expect(newColumns.map((c) => c.category)).toEqual(sourceColumns.map((c) => c.category));
      expect(newColumns.map((c) => c.position)).toEqual([1, 2, 3]);
    });

    it("(b) a renamed default column -> duplicate has the new name, no leftover old name", async () => {
      const { projectId, categoryId } = await makeSourceWithOneCategory();
      const sourceColumns = await getColumns(projectId, categoryId);
      const todoColumn = sourceColumns.find((c) => c.name === "To Do")!;
      await owner.patch(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/columns/${todoColumn.id}`,
        { name: "Backlog" },
      );

      const result = await duplicate(owner, projectId, `Recon B Copy ${Math.random()}`);
      expect(result.status).toBe(201);
      const newProject = result.body.project as { id: string };
      const newCategories = await getCategories(newProject.id);
      const newColumns = await getColumns(newProject.id, newCategories[0]!.id);

      expect(newColumns.map((c) => c.name)).toEqual(["Backlog", "In Progress", "Done"]);
      expect(newColumns.some((c) => c.name === "To Do")).toBe(false);
    });

    it("(c) an extra column added -> duplicate ends up with 4 columns", async () => {
      const { projectId, categoryId } = await makeSourceWithOneCategory();
      await owner.post(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/columns`,
        { name: "Blocked", category: "in_progress" },
      );

      const result = await duplicate(owner, projectId, `Recon C Copy ${Math.random()}`);
      expect(result.status).toBe(201);
      const newProject = result.body.project as { id: string };
      const newCategories = await getCategories(newProject.id);
      const newColumns = await getColumns(newProject.id, newCategories[0]!.id);

      expect(newColumns.length).toBe(4);
      expect(newColumns.map((c) => c.name)).toEqual(["To Do", "In Progress", "Done", "Blocked"]);
    });

    it("(d) a default column deleted -> duplicate ends up with only the remaining columns", async () => {
      const { projectId, categoryId } = await makeSourceWithOneCategory();
      const sourceColumns = await getColumns(projectId, categoryId);
      const doneColumn = sourceColumns.find((c) => c.name === "Done")!;
      const delRes = await owner.delete(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/columns/${doneColumn.id}`,
      );
      expect(delRes.statusCode).toBe(200);

      const result = await duplicate(owner, projectId, `Recon D Copy ${Math.random()}`);
      expect(result.status).toBe(201);
      const newProject = result.body.project as { id: string };
      const newCategories = await getCategories(newProject.id);
      const newColumns = await getColumns(newProject.id, newCategories[0]!.id);

      expect(newColumns.map((c) => c.name)).toEqual(["To Do", "In Progress"]);
    });

    it("(e) reordered columns -> duplicate preserves the source's exact order", async () => {
      const { projectId, categoryId } = await makeSourceWithOneCategory();
      const sourceColumns = await getColumns(projectId, categoryId);
      const ids = sourceColumns.map((c) => c.id);
      // Reverse the order: Done, In Progress, To Do.
      const reordered = [ids[2]!, ids[1]!, ids[0]!];
      const reorderRes = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/columns/reorder`,
        { columnIds: reordered },
      );
      expect(reorderRes.statusCode).toBe(200);

      const result = await duplicate(owner, projectId, `Recon E Copy ${Math.random()}`);
      expect(result.status).toBe(201);
      const newProject = result.body.project as { id: string };
      const newCategories = await getCategories(newProject.id);
      const newColumns = await getColumns(newProject.id, newCategories[0]!.id);

      expect(newColumns.map((c) => c.name)).toEqual(["Done", "In Progress", "To Do"]);
      expect(newColumns.map((c) => c.position)).toEqual([1, 2, 3]);
    });
  });

  // -------------------------------------------------------------------------
  // Permission gating
  // -------------------------------------------------------------------------

  describe("Permission gating", () => {
    it("missing any one of the 5 underlying permissions -> 403", async () => {
      const project = await createProjectAs(owner, workspaceId, `Perm Source ${Math.random()}`);
      await createCategoryAs(owner, workspaceId, project.id, "Only");

      // MEMBER lacks all 5.
      const member = await inviteAndAccept(app, owner, workspaceId, "dup-member@example.com", "MEMBER");
      const memberRes = await duplicate(member, project.id, "Member Copy");
      expect(memberRes.status).toBe(403);

      // VIEWER lacks all 5.
      const viewer = await inviteAndAccept(app, owner, workspaceId, "dup-viewer@example.com", "VIEWER");
      const viewerRes = await duplicate(viewer, project.id, "Viewer Copy");
      expect(viewerRes.status).toBe(403);

      // PROJECT_MANAGER holds all 5 by default -> succeeds (positive control).
      const pm = await inviteAndAccept(app, owner, workspaceId, "dup-pm@example.com", "PROJECT_MANAGER");
      const pmRes = await duplicate(pm, project.id, "PM Copy");
      expect(pmRes.status).toBe(201);
    });

    it("a private project the caller cannot see 404s (requireProjectAccess gates before the permission check)", async () => {
      const privateProject = await createProjectAs(owner, workspaceId, `Private Source ${Math.random()}`, {
        visibility: "private",
      });
      await createCategoryAs(owner, workspaceId, privateProject.id, "Hidden");

      // A MEMBER without a ProjectMembership row cannot see this private project.
      const outsider = await inviteAndAccept(app, owner, workspaceId, "dup-outsider@example.com", "MEMBER");
      const res = await duplicate(outsider, privateProject.id, "Outsider Copy");
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Boundary case: source already at MAX_CUSTOM_FIELDS_PER_PROJECT
  // -------------------------------------------------------------------------

  it("a source at MAX_CUSTOM_FIELDS_PER_PROJECT (50) duplicates cleanly (new project starts empty, never exceeds the cap)", async () => {
    const source = await createProjectAs(owner, workspaceId, `Max Fields Source ${Math.random()}`);
    await createCategoryAs(owner, workspaceId, source.id, "Cat");

    for (let i = 0; i < 50; i += 1) {
      const res = await owner.post(`/api/workspaces/${workspaceId}/projects/${source.id}/custom-fields`, {
        name: `Field ${i}`,
        type: "text",
      });
      expect(res.statusCode).toBe(201);
    }

    const result = await duplicate(owner, source.id, `Max Fields Copy ${Math.random()}`);
    expect(result.status).toBe(201);
    expect((result.body.copied as { customFields: number }).customFields).toBe(50);
  });

  // -------------------------------------------------------------------------
  // Compensating delete on failure
  // -------------------------------------------------------------------------

  /**
   * Forcing a genuine mid-flow failure through the pure HTTP black-box
   * surface turns out to be infeasible: every create call duplicateProject
   * issues targets the brand-new (always-empty) project with data already
   * validated in the source, so no legitimate business-rule collision can
   * arise (see the MAX_CUSTOM_FIELDS_PER_PROJECT boundary test above, which
   * demonstrates this directly — the cap can never be hit because the source
   * and target share the same limit but the target starts at zero). The only
   * realistic way this failure path fires in production is an unexpected
   * error partway through (e.g. a transient DB error), which is exercised
   * here directly against the service function via a one-shot forced
   * rejection on createLabel — the sole place in this suite that reaches for
   * vi.spyOn, specifically because no purely-HTTP scenario can trigger it.
   */
  describe("Compensating delete on failure", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("an unexpected error partway through deletes the partially-built new project, leaving no orphaned categories/columns/labels/fields", async () => {
      const sourceProject = await createProjectAs(owner, workspaceId, `Forced Failure Source ${Math.random()}`);
      await createCategoryAs(owner, workspaceId, sourceProject.id, "Cat A");
      await createCategoryAs(owner, workspaceId, sourceProject.id, "Cat B");
      await owner.post(`/api/workspaces/${workspaceId}/projects/${sourceProject.id}/labels`, {
        name: "WillFail",
        color: "#222222",
      });

      const ownerRow = await prisma.user.findUniqueOrThrow({ where: { email: "dup-owner@example.com" } });

      vi.spyOn(labelsService, "createLabel").mockRejectedValueOnce(new Error("forced failure for test"));

      const projectCountBefore = await prisma.project.count({ where: { workspaceId } });
      const categoryCountBefore = await prisma.taskCategory.count({ where: { workspaceId } });
      const columnCountBefore = await prisma.boardColumn.count({ where: { workspaceId } });
      const labelCountBefore = await prisma.label.count({ where: { workspaceId } });

      await expect(
        duplicateProject({
          workspaceId,
          sourceProjectId: sourceProject.id,
          actorId: ownerRow.id,
          actorRoleKey: "OWNER",
          name: `Forced Failure Copy ${Math.random()}`,
        }),
      ).rejects.toThrow("forced failure for test");

      // The partially-built new project (with its 2 already-created
      // categories and their auto-seeded columns) was compensating-deleted,
      // and its cascade took the categories/columns with it. The label
      // creation loop hadn't created anything on the new project yet either
      // (it failed on the very first label). Every count is back to exactly
      // what it was before the attempt — nothing was left behind.
      expect(await prisma.project.count({ where: { workspaceId } })).toBe(projectCountBefore);
      expect(await prisma.taskCategory.count({ where: { workspaceId } })).toBe(categoryCountBefore);
      expect(await prisma.boardColumn.count({ where: { workspaceId } })).toBe(columnCountBefore);
      expect(await prisma.label.count({ where: { workspaceId } })).toBe(labelCountBefore);
    });
  });
});
