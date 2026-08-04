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

interface TemplateRef {
  id: string;
  projectId: string;
  name: string;
  titleTemplate: string;
  description: string | null;
  priority: string | null;
  defaultLabelIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Task templates: project-scoped canned task blueprints (TaskTemplate,
 * task_template.manage). Covers CRUD, name-uniqueness, defaultLabelIds
 * validation/IDOR, permission gating (GET ungated, writes gated), and the
 * "create from template" integration flow the frontend performs client-side
 * (create task, then attach each default label).
 */
describe("Task templates", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;
  let projectId: string;
  let categoryId: string;
  let labelAId: string;
  let labelBId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "tt-owner@example.com");
    const ws = await createWorkspaceAs(owner, "Templates Co", "templates-co");
    workspaceId = ws.id;

    const project = await createProjectAs(owner, workspaceId, "TT Project");
    projectId = project.id;

    const category = await createCategoryAs(owner, workspaceId, projectId, "Main");
    categoryId = category.id;

    const labelA = await owner.post(`/api/workspaces/${workspaceId}/projects/${projectId}/labels`, {
      name: "Bug",
      color: "#ff0000",
    });
    labelAId = labelA.json().label.id;
    const labelB = await owner.post(`/api/workspaces/${workspaceId}/projects/${projectId}/labels`, {
      name: "Urgent",
      color: "#00ff00",
    });
    labelBId = labelB.json().label.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  function templatesUrl(): string {
    return `/api/workspaces/${workspaceId}/projects/${projectId}/task-templates`;
  }

  async function createTemplate(
    client: TestClient,
    body: Record<string, unknown>,
  ): Promise<{ status: number; template?: TemplateRef; body: unknown }> {
    const res = await client.post(templatesUrl(), body);
    return {
      status: res.statusCode,
      template: res.statusCode === 201 ? res.json().template : undefined,
      body: res.json(),
    };
  }

  it("GET on a fresh project returns an empty list", async () => {
    const res = await owner.get(templatesUrl());
    expect(res.statusCode).toBe(200);
    expect(res.json().templates).toEqual([]);
  });

  let bugFixId: string;
  let featureId: string;

  it("creates templates and lists them ordered createdAt asc", async () => {
    const first = await createTemplate(owner, {
      name: "Bug Fix",
      titleTemplate: "Fix bug in [component]",
      description: "Investigate and fix",
      priority: "high",
      defaultLabelIds: [labelAId, labelBId],
    });
    expect(first.status).toBe(201);
    expect(first.template!.defaultLabelIds).toEqual([labelAId, labelBId]);
    bugFixId = first.template!.id;

    const second = await createTemplate(owner, {
      name: "Feature Request",
      titleTemplate: "Implement [feature]",
    });
    expect(second.status).toBe(201);
    expect(second.template!.description).toBeNull();
    expect(second.template!.priority).toBeNull();
    expect(second.template!.defaultLabelIds).toEqual([]);
    featureId = second.template!.id;

    const listRes = await owner.get(templatesUrl());
    const templates = listRes.json().templates as TemplateRef[];
    expect(templates.map((t) => t.id)).toEqual([bugFixId, featureId]);
  });

  it("rejects a duplicate template name within the same project with 409", async () => {
    const res = await createTemplate(owner, { name: "Bug Fix", titleTemplate: "Another title" });
    expect(res.status).toBe(409);
  });

  it("update: rename, clear description/priority, replace defaultLabelIds", async () => {
    const rename = await owner.patch(`${templatesUrl()}/${featureId}`, { name: "Feature Request Renamed" });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().template.name).toBe("Feature Request Renamed");

    const setDesc = await owner.patch(`${templatesUrl()}/${featureId}`, {
      description: "Some description",
      priority: "low",
      defaultLabelIds: [labelAId],
    });
    expect(setDesc.statusCode).toBe(200);
    expect(setDesc.json().template.description).toBe("Some description");
    expect(setDesc.json().template.defaultLabelIds).toEqual([labelAId]);

    const clear = await owner.patch(`${templatesUrl()}/${featureId}`, { description: null, priority: null });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().template.description).toBeNull();
    expect(clear.json().template.priority).toBeNull();
    // untouched keys stay as-is
    expect(clear.json().template.defaultLabelIds).toEqual([labelAId]);
  });

  it("defaultLabelIds validation: too many, duplicates, and a foreign-project id all 422", async () => {
    const tooMany = await createTemplate(owner, {
      name: "Too Many Labels",
      titleTemplate: "x",
      // 21 genuinely distinct ids exceeds MAX_TASK_TEMPLATE_DEFAULT_LABELS
      // (20) without also tripping the duplicate check.
      defaultLabelIds: Array.from({ length: 21 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`),
    });
    expect(tooMany.status).toBe(422);

    const dup = await createTemplate(owner, {
      name: "Dup Labels",
      titleTemplate: "x",
      defaultLabelIds: [labelAId, labelAId],
    });
    expect(dup.status).toBe(422);

    const otherOwner = await registerAndLogin(app, "tt-owner2@example.com");
    const otherWs = await createWorkspaceAs(otherOwner, "Foreign TT Co", "foreign-tt-co");
    const otherProject = await createProjectAs(otherOwner, otherWs.id, "Foreign TT Project");
    const foreignLabelRes = await otherOwner.post(
      `/api/workspaces/${otherWs.id}/projects/${otherProject.id}/labels`,
      { name: "Foreign", color: "#123456" },
    );
    const foreignLabelId = foreignLabelRes.json().label.id;

    const foreignLabel = await createTemplate(owner, {
      name: "Foreign Label Template",
      titleTemplate: "x",
      defaultLabelIds: [foreignLabelId],
    });
    expect([404, 422]).toContain(foreignLabel.status);
  });

  it("MEMBER can GET but gets 403 on POST/PATCH/DELETE (lacks task_template.manage)", async () => {
    const member = await inviteAndAccept(app, owner, workspaceId, "tt-member@example.com", "MEMBER");

    const getRes = await member.get(templatesUrl());
    expect(getRes.statusCode).toBe(200);

    const createRes = await member.post(templatesUrl(), { name: "Member Template", titleTemplate: "x" });
    expect(createRes.statusCode).toBe(403);

    const patchRes = await member.patch(`${templatesUrl()}/${bugFixId}`, { name: "Hacked" });
    expect(patchRes.statusCode).toBe(403);

    const deleteRes = await member.delete(`${templatesUrl()}/${bugFixId}`);
    expect(deleteRes.statusCode).toBe(403);
  });

  it("PROJECT_MANAGER (holds task_template.manage) succeeds on writes", async () => {
    const pm = await inviteAndAccept(app, owner, workspaceId, "tt-pm@example.com", "PROJECT_MANAGER");
    const res = await pm.post(templatesUrl(), { name: "PM Template", titleTemplate: "x" });
    expect(res.statusCode).toBe(201);
  });

  it("VIEWER cannot create templates", async () => {
    const viewer = await inviteAndAccept(app, owner, workspaceId, "tt-viewer@example.com", "VIEWER");
    const res = await viewer.post(templatesUrl(), { name: "Viewer Template", titleTemplate: "x" });
    expect(res.statusCode).toBe(403);
  });

  it("deletes a template; a second delete 404s", async () => {
    const created = await createTemplate(owner, { name: "Deletable", titleTemplate: "x" });
    const del1 = await owner.delete(`${templatesUrl()}/${created.template!.id}`);
    expect(del1.statusCode).toBe(200);
    const del2 = await owner.delete(`${templatesUrl()}/${created.template!.id}`);
    expect(del2.statusCode).toBe(404);
  });

  it("integration: create-from-template flow — create task then attach each default label", async () => {
    const template = await createTemplate(owner, {
      name: "From Template Flow",
      titleTemplate: "Fix bug in payments",
      description: "Investigate payment failures",
      priority: "urgent",
      defaultLabelIds: [labelAId, labelBId],
    });
    expect(template.status).toBe(201);
    const t = template.template!;

    const taskRes = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`,
      { title: t.titleTemplate, description: t.description ?? undefined, priority: t.priority ?? undefined },
    );
    expect(taskRes.statusCode).toBe(201);
    const task = taskRes.json().task;
    expect(task.title).toBe(t.titleTemplate);
    expect(task.description).toBe(t.description);
    expect(task.priority).toBe(t.priority);

    for (const labelId of t.defaultLabelIds) {
      const attachRes = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${task.id}/labels/${labelId}`,
      );
      expect(attachRes.statusCode).toBe(201);
    }

    const finalRes = await owner.get(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${task.id}`,
    );
    expect(finalRes.statusCode).toBe(200);
    const finalTask = finalRes.json().task;
    const attachedLabelIds = (finalTask.labels ?? []).map((l: { labelId?: string; id?: string }) => l.labelId ?? l.id);
    expect(attachedLabelIds.sort()).toEqual([...t.defaultLabelIds].sort());
  });
});
