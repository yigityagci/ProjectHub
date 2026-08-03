import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/core/prisma.js";
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
  cookieHeaderFor,
  freshClient,
  type TestClient,
} from "./helpers.js";

interface FieldRef {
  id: string;
  projectId: string;
  name: string;
  type: string;
  options: string[];
  position: number;
}

/**
 * Custom fields: project-scoped typed field definitions
 * (CustomFieldDefinition, custom_field.manage) plus per-task values
 * (CustomFieldValue, task.edit — deliberately a different permission).
 * Covers definition CRUD/reorder/permissions, per-type value validation, the
 * value PUT/DELETE permission split, IDOR/cross-tenant isolation, and the
 * stale-value policy that follows from `options` being editable while `type`
 * is immutable.
 */
describe("Custom fields on tasks", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;
  let projectId: string;
  let categoryId: string;
  let taskId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "cf-owner@example.com");
    const ws = await createWorkspaceAs(owner, "Custom Fields Co", "custom-fields-co");
    workspaceId = ws.id;

    const project = await createProjectAs(owner, workspaceId, "CF Project");
    projectId = project.id;

    const category = await createCategoryAs(owner, workspaceId, projectId, "Main");
    categoryId = category.id;

    const taskRes = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`,
      { title: "CF Task" },
    );
    taskId = taskRes.json().task.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  function fieldsUrl(): string {
    return `/api/workspaces/${workspaceId}/projects/${projectId}/custom-fields`;
  }

  function valuesUrl(tId = taskId, cId = categoryId): string {
    return `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${cId}/tasks/${tId}/custom-fields`;
  }

  async function createTaskAs(client: TestClient, title: string): Promise<string> {
    const res = await client.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`,
      { title },
    );
    expect(res.statusCode).toBe(201);
    return res.json().task.id;
  }

  async function createField(
    client: TestClient,
    body: Record<string, unknown>,
  ): Promise<{ status: number; field?: FieldRef; body: unknown }> {
    const res = await client.post(fieldsUrl(), body);
    return { status: res.statusCode, field: res.statusCode === 201 ? res.json().field : undefined, body: res.json() };
  }

  // -------------------------------------------------------------------------
  // Definition CRUD + permissions
  // -------------------------------------------------------------------------

  it("GET on a fresh project returns an empty field list", async () => {
    const res = await owner.get(fieldsUrl());
    expect(res.statusCode).toBe(200);
    expect(res.json().fields).toEqual([]);
  });

  const typeFixtures: Array<{ name: string; type: string; options?: string[] }> = [
    { name: "Text Field", type: "text" },
    { name: "Number Field", type: "number" },
    { name: "Date Field", type: "date" },
    { name: "Select Field", type: "select", options: ["A", "B", "C"] },
    { name: "Multi Field", type: "multi_select", options: ["X", "Y"] },
    { name: "Checkbox Field", type: "checkbox" },
    { name: "Url Field", type: "url" },
  ];
  const fieldIdByType: Record<string, string> = {};

  it("creates one field of each of the 7 types", async () => {
    for (const fixture of typeFixtures) {
      const { status, field } = await createField(owner, fixture);
      expect(status).toBe(201);
      if (fixture.options) {
        expect(field!.options).toEqual(fixture.options);
      } else {
        expect(field!.options).toEqual([]);
      }
      fieldIdByType[fixture.type] = field!.id;
    }
  });

  it("create validation: select needs options, non-select rejects options, duplicate/oversized options 422", async () => {
    const noOptions = await createField(owner, { name: "Bad Select", type: "select" });
    expect(noOptions.status).toBe(422);

    const wrongType = await createField(owner, { name: "Bad Text", type: "text", options: ["A"] });
    expect(wrongType.status).toBe(422);

    const dup = await createField(owner, { name: "Dup Select", type: "select", options: ["A", "A"] });
    expect(dup.status).toBe(422);

    const tooMany = await createField(owner, {
      name: "Big Select",
      type: "select",
      options: Array.from({ length: 51 }, (_, i) => `opt-${i}`),
    });
    expect(tooMany.status).toBe(422);
  });

  it("rejects a duplicate field name within the same project, allows it in a different project", async () => {
    const dup = await createField(owner, { name: "Text Field", type: "text" });
    expect(dup.status).toBe(409);

    const otherProject = await createProjectAs(owner, workspaceId, "Other CF Project");
    const res = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${otherProject.id}/custom-fields`,
      { name: "Text Field", type: "text" },
    );
    expect(res.statusCode).toBe(201);
  });

  it("update: rename works; type/position in body 422; options edits on wrong type/emptied on select 422", async () => {
    const rename = await owner.patch(`${fieldsUrl()}/${fieldIdByType.text}`, { name: "Text Field Renamed" });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().field.name).toBe("Text Field Renamed");
    // revert for later tests that reference "Text Field" by fixture identity
    await owner.patch(`${fieldsUrl()}/${fieldIdByType.text}`, { name: "Text Field" });

    const typeInBody = await owner.patch(`${fieldsUrl()}/${fieldIdByType.text}`, { type: "number" });
    expect(typeInBody.statusCode).toBe(422);

    const positionInBody = await owner.patch(`${fieldsUrl()}/${fieldIdByType.text}`, { position: 99 });
    expect(positionInBody.statusCode).toBe(422);

    const optionsOnText = await owner.patch(`${fieldsUrl()}/${fieldIdByType.text}`, { options: ["A"] });
    expect(optionsOnText.statusCode).toBe(422);

    const emptyOptionsOnSelect = await owner.patch(`${fieldsUrl()}/${fieldIdByType.select}`, { options: [] });
    expect(emptyOptionsOnSelect.statusCode).toBe(422);
  });

  it("MEMBER can GET but not create/update/reorder/delete fields (lacks custom_field.manage)", async () => {
    const member = await inviteAndAccept(app, owner, workspaceId, "cf-member@example.com", "MEMBER");

    const getRes = await member.get(fieldsUrl());
    expect(getRes.statusCode).toBe(200);

    const createRes = await member.post(fieldsUrl(), { name: "Member Field", type: "text" });
    expect(createRes.statusCode).toBe(403);

    const patchRes = await member.patch(`${fieldsUrl()}/${fieldIdByType.text}`, { name: "Hacked" });
    expect(patchRes.statusCode).toBe(403);

    const reorderRes = await member.post(`${fieldsUrl()}/reorder`, {
      fieldIds: Object.values(fieldIdByType),
    });
    expect(reorderRes.statusCode).toBe(403);

    const deleteRes = await member.delete(`${fieldsUrl()}/${fieldIdByType.checkbox}`);
    expect(deleteRes.statusCode).toBe(403);
  });

  it("PROJECT_MANAGER can create fields (positive control)", async () => {
    const pm = await inviteAndAccept(app, owner, workspaceId, "cf-pm@example.com", "PROJECT_MANAGER");
    const res = await pm.post(fieldsUrl(), { name: "PM Field", type: "text" });
    expect(res.statusCode).toBe(201);
  });

  it("VIEWER cannot create fields", async () => {
    const viewer = await inviteAndAccept(app, owner, workspaceId, "cf-viewer@example.com", "VIEWER");
    const res = await viewer.post(fieldsUrl(), { name: "Viewer Field", type: "text" });
    expect(res.statusCode).toBe(403);
  });

  it("a field id belonging to another workspace's project 404s on PATCH/DELETE against this project", async () => {
    const owner2 = await registerAndLogin(app, "cf-owner2@example.com");
    const ws2 = await createWorkspaceAs(owner2, "Foreign CF Co", "foreign-cf-co");
    const project2 = await createProjectAs(owner2, ws2.id, "Foreign CF Project");
    const foreignFieldRes = await owner2.post(
      `/api/workspaces/${ws2.id}/projects/${project2.id}/custom-fields`,
      { name: "Foreign Field", type: "text" },
    );
    const foreignFieldId = foreignFieldRes.json().field.id;

    const patchRes = await owner.patch(`${fieldsUrl()}/${foreignFieldId}`, { name: "Hacked" });
    expect(patchRes.statusCode).toBe(404);

    const deleteRes = await owner.delete(`${fieldsUrl()}/${foreignFieldId}`);
    expect(deleteRes.statusCode).toBe(404);
  });

  it("deleting a definition that has value rows removes the values too, task itself survives", async () => {
    const { field } = await createField(owner, { name: "Deletable Field", type: "text" });
    const putRes = await owner.put(`${valuesUrl()}/${field!.id}`, { value: "some value" });
    expect(putRes.statusCode).toBe(200);

    const countBefore = await prisma.customFieldValue.count({ where: { fieldId: field!.id } });
    expect(countBefore).toBe(1);

    const deleteRes = await owner.delete(`${fieldsUrl()}/${field!.id}`);
    expect(deleteRes.statusCode).toBe(200);

    const countAfter = await prisma.customFieldValue.count({ where: { fieldId: field!.id } });
    expect(countAfter).toBe(0);

    const taskRes = await owner.get(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks/${taskId}`,
    );
    expect(taskRes.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Reorder
  // -------------------------------------------------------------------------

  describe("Reorder", () => {
    let reorderProjectId: string;
    let r1: string;
    let r2: string;
    let r3: string;

    beforeAll(async () => {
      const project = await createProjectAs(owner, workspaceId, "Reorder Project");
      reorderProjectId = project.id;

      const base = `/api/workspaces/${workspaceId}/projects/${reorderProjectId}/custom-fields`;
      const a = await owner.post(base, { name: "R1", type: "text" });
      const b = await owner.post(base, { name: "R2", type: "text" });
      const c = await owner.post(base, { name: "R3", type: "text" });
      r1 = a.json().field.id;
      r2 = b.json().field.id;
      r3 = c.json().field.id;
    });

    function reorderBase(): string {
      return `/api/workspaces/${workspaceId}/projects/${reorderProjectId}/custom-fields`;
    }

    it("initial position ordering is creation order", async () => {
      const res = await owner.get(reorderBase());
      const fields = res.json().fields as FieldRef[];
      expect(fields.map((f) => f.id)).toEqual([r1, r2, r3]);
    });

    it("reorders a permuted complete list to positions exactly 1,2,3", async () => {
      const res = await owner.post(`${reorderBase()}/reorder`, { fieldIds: [r3, r1, r2] });
      expect(res.statusCode).toBe(200);
      const fields = res.json().fields as FieldRef[];
      expect(fields.map((f) => f.id)).toEqual([r3, r1, r2]);
      expect(fields.map((f) => f.position)).toEqual([1, 2, 3]);

      const getRes = await owner.get(reorderBase());
      expect((getRes.json().fields as FieldRef[]).map((f) => f.id)).toEqual([r3, r1, r2]);
    });

    it("rejects a partial list, a duplicated id, or a foreign id with 404", async () => {
      const partial = await owner.post(`${reorderBase()}/reorder`, { fieldIds: [r1, r2] });
      expect(partial.statusCode).toBe(404);

      const duplicated = await owner.post(`${reorderBase()}/reorder`, { fieldIds: [r1, r1, r2] });
      expect(duplicated.statusCode).toBe(404);

      const foreign = await owner.post(`${reorderBase()}/reorder`, {
        fieldIds: [r1, r2, "00000000-0000-0000-0000-000000000000"],
      });
      expect(foreign.statusCode).toBe(404);
    });

    it("rejects an empty fieldIds array with 422", async () => {
      const res = await owner.post(`${reorderBase()}/reorder`, { fieldIds: [] });
      expect(res.statusCode).toBe(422);
    });
  });

  // -------------------------------------------------------------------------
  // Set value: success + failure per type
  // -------------------------------------------------------------------------

  describe("Value validation per type", () => {
    it("text: success trims, empty/too-long/wrong-type fail with no row created", async () => {
      const ok = await owner.put(`${valuesUrl()}/${fieldIdByType.text}`, { value: "hello " });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().value.value).toBe("hello");
      await owner.delete(`${valuesUrl()}/${fieldIdByType.text}`);

      const empty = await owner.put(`${valuesUrl()}/${fieldIdByType.text}`, { value: "" });
      expect(empty.statusCode).toBe(422);

      const tooLong = await owner.put(`${valuesUrl()}/${fieldIdByType.text}`, { value: "x".repeat(1001) });
      expect(tooLong.statusCode).toBe(422);

      const wrongType = await owner.put(`${valuesUrl()}/${fieldIdByType.text}`, { value: 123 });
      expect(wrongType.statusCode).toBe(422);

      const count = await prisma.customFieldValue.count({ where: { fieldId: fieldIdByType.text } });
      expect(count).toBe(0);
    });

    it("number: success, string/boolean fail", async () => {
      const ok = await owner.put(`${valuesUrl()}/${fieldIdByType.number}`, { value: 42.5 });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().value.value).toBe(42.5);

      const asString = await owner.put(`${valuesUrl()}/${fieldIdByType.number}`, { value: "42" });
      expect(asString.statusCode).toBe(422);

      const asBool = await owner.put(`${valuesUrl()}/${fieldIdByType.number}`, { value: true });
      expect(asBool.statusCode).toBe(422);
    });

    it("date: valid calendar date succeeds; malformed/invalid-calendar/datetime fail", async () => {
      const ok = await owner.put(`${valuesUrl()}/${fieldIdByType.date}`, { value: "2026-08-03" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().value.value).toBe("2026-08-03");

      const wrongFormat = await owner.put(`${valuesUrl()}/${fieldIdByType.date}`, { value: "03/08/2026" });
      expect(wrongFormat.statusCode).toBe(422);

      const invalidCalendar = await owner.put(`${valuesUrl()}/${fieldIdByType.date}`, { value: "2026-02-30" });
      expect(invalidCalendar.statusCode).toBe(422);

      const withTime = await owner.put(`${valuesUrl()}/${fieldIdByType.date}`, {
        value: "2026-08-03T10:00:00Z",
      });
      expect(withTime.statusCode).toBe(422);
    });

    it("select: valid option succeeds; invalid option fails", async () => {
      const ok = await owner.put(`${valuesUrl()}/${fieldIdByType.select}`, { value: "B" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().value.value).toBe("B");

      const bad = await owner.put(`${valuesUrl()}/${fieldIdByType.select}`, { value: "Nope" });
      expect(bad.statusCode).toBe(422);
    });

    it("multi_select: valid options succeed; empty/non-array/invalid-entry/duplicates fail", async () => {
      const ok = await owner.put(`${valuesUrl()}/${fieldIdByType.multi_select}`, { value: ["X", "Y"] });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().value.value).toEqual(["X", "Y"]);

      const empty = await owner.put(`${valuesUrl()}/${fieldIdByType.multi_select}`, { value: [] });
      expect(empty.statusCode).toBe(422);

      const notArray = await owner.put(`${valuesUrl()}/${fieldIdByType.multi_select}`, { value: "X" });
      expect(notArray.statusCode).toBe(422);

      const invalidEntry = await owner.put(`${valuesUrl()}/${fieldIdByType.multi_select}`, {
        value: ["X", "Nope"],
      });
      expect(invalidEntry.statusCode).toBe(422);

      const duplicates = await owner.put(`${valuesUrl()}/${fieldIdByType.multi_select}`, {
        value: ["X", "X"],
      });
      expect(duplicates.statusCode).toBe(422);
    });

    it("checkbox: false stored as false (not falsy-omitted); string/number fail", async () => {
      const ok = await owner.put(`${valuesUrl()}/${fieldIdByType.checkbox}`, { value: false });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().value.value).toBe(false);

      const asString = await owner.put(`${valuesUrl()}/${fieldIdByType.checkbox}`, { value: "true" });
      expect(asString.statusCode).toBe(422);

      const asNumber = await owner.put(`${valuesUrl()}/${fieldIdByType.checkbox}`, { value: 1 });
      expect(asNumber.statusCode).toBe(422);
    });

    it("url: valid http(s) succeeds; garbage/javascript:/data: schemes fail", async () => {
      const ok = await owner.put(`${valuesUrl()}/${fieldIdByType.url}`, { value: "https://example.com/x" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().value.value).toBe("https://example.com/x");

      const notAUrl = await owner.put(`${valuesUrl()}/${fieldIdByType.url}`, { value: "not a url" });
      expect(notAUrl.statusCode).toBe(422);

      const jsScheme = await owner.put(`${valuesUrl()}/${fieldIdByType.url}`, { value: "javascript:alert(1)" });
      expect(jsScheme.statusCode).toBe(422);

      const dataScheme = await owner.put(`${valuesUrl()}/${fieldIdByType.url}`, {
        value: "data:text/html,<script>",
      });
      expect(dataScheme.statusCode).toBe(422);
    });

    it("envelope: missing key, explicit null, and extra keys are all 422 (strict, non-nullable)", async () => {
      const missing = await owner.put(`${valuesUrl()}/${fieldIdByType.text}`, {});
      expect(missing.statusCode).toBe(422);

      const explicitNull = await owner.put(`${valuesUrl()}/${fieldIdByType.text}`, { value: null });
      expect(explicitNull.statusCode).toBe(422);

      const extraKey = await owner.put(`${valuesUrl()}/${fieldIdByType.text}`, { value: 1, extra: 1 });
      expect(extraKey.statusCode).toBe(422);
    });

    it("PUT twice on the same (task, field) leaves exactly one row, second value wins", async () => {
      await owner.put(`${valuesUrl()}/${fieldIdByType.text}`, { value: "first" });
      const second = await owner.put(`${valuesUrl()}/${fieldIdByType.text}`, { value: "second" });
      expect(second.statusCode).toBe(200);
      expect(second.json().value.value).toBe("second");

      const count = await prisma.customFieldValue.count({
        where: { taskId, fieldId: fieldIdByType.text },
      });
      expect(count).toBe(1);
    });

    it("GET the value list returns every set value with stale: false", async () => {
      const res = await owner.get(valuesUrl());
      expect(res.statusCode).toBe(200);
      const values = res.json().values as Array<{ fieldId: string; stale: boolean }>;
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) {
        expect(v.stale).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Permission gating on the value endpoints
  // -------------------------------------------------------------------------

  describe("Value endpoint permission gating (task.edit, not custom_field.manage)", () => {
    it("MEMBER (has task.edit, lacks custom_field.manage) can PUT a value — headline assertion", async () => {
      const member = await inviteAndAccept(app, owner, workspaceId, "cf-member-value@example.com", "MEMBER");
      const memberTaskId = await createTaskAs(owner, "Member Value Task");

      const res = await member.put(`${valuesUrl(memberTaskId)}/${fieldIdByType.text}`, { value: "member set" });
      expect(res.statusCode).toBe(200);
    });

    it("VIEWER (neither permission) is denied PUT and DELETE with 403", async () => {
      const viewer = await inviteAndAccept(app, owner, workspaceId, "cf-viewer-value@example.com", "VIEWER");
      const viewerTaskId = await createTaskAs(owner, "Viewer Value Task");

      const putRes = await viewer.put(`${valuesUrl(viewerTaskId)}/${fieldIdByType.text}`, { value: "nope" });
      expect(putRes.statusCode).toBe(403);

      const deleteRes = await viewer.delete(`${valuesUrl(viewerTaskId)}/${fieldIdByType.text}`);
      expect(deleteRes.statusCode).toBe(403);
    });

    it("value routes reached with a foreign categoryId (from another project) 404, never 200/403", async () => {
      const otherProject = await createProjectAs(owner, workspaceId, "Foreign Category Project");
      const otherCategory = await createCategoryAs(owner, workspaceId, otherProject.id, "Foreign Cat");

      const res = await owner.get(valuesUrl(taskId, otherCategory.id));
      expect(res.statusCode).toBe(404);

      const putRes = await owner.put(`${valuesUrl(taskId, otherCategory.id)}/${fieldIdByType.text}`, {
        value: "nope",
      });
      expect(putRes.statusCode).toBe(404);
    });

    it("unauthenticated GET/PUT is 401; mutating routes without a CSRF header are 401", async () => {
      const anon = freshClient(app);

      const getRes = await anon.get(fieldsUrl());
      expect(getRes.statusCode).toBe(401);

      const putRes = await anon.put(`${valuesUrl()}/${fieldIdByType.text}`, { value: "x" });
      expect(putRes.statusCode).toBe(401);

      const postFieldRes = await anon.post(fieldsUrl(), { name: "Anon Field", type: "text" });
      expect(postFieldRes.statusCode).toBe(401);

      // Logged-in cookie present, but no CSRF header attached (raw inject
      // bypasses TestClient's automatic X-CSRF-Token attachment).
      const noCsrfRes = await app.inject({
        method: "PUT",
        url: `${valuesUrl()}/${fieldIdByType.text}`,
        payload: { value: "no csrf" },
        headers: { cookie: cookieHeaderFor(owner), "content-type": "application/json" },
      });
      expect(noCsrfRes.statusCode).toBe(401);

      const noCsrfDeleteRes = await app.inject({
        method: "DELETE",
        url: `${fieldsUrl()}/${fieldIdByType.checkbox}`,
        headers: { cookie: cookieHeaderFor(owner) },
      });
      expect(noCsrfDeleteRes.statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Clear + stale policy
  // -------------------------------------------------------------------------

  describe("Clear semantics and stale-value policy", () => {
    it("DELETE clears a set value; second DELETE is 404 (non-idempotent, matches removeLabel)", async () => {
      await owner.put(`${valuesUrl()}/${fieldIdByType.checkbox}`, { value: true });

      const del1 = await owner.delete(`${valuesUrl()}/${fieldIdByType.checkbox}`);
      expect(del1.statusCode).toBe(200);

      const getRes = await owner.get(valuesUrl());
      const values = getRes.json().values as Array<{ fieldId: string }>;
      expect(values.some((v) => v.fieldId === fieldIdByType.checkbox)).toBe(false);

      const del2 = await owner.delete(`${valuesUrl()}/${fieldIdByType.checkbox}`);
      expect(del2.statusCode).toBe(404);
    });

    it("editing a select field's options to remove a used option marks its existing value stale, blocks re-writing it, but a still-valid option round-trips fresh", async () => {
      const putRes = await owner.put(`${valuesUrl()}/${fieldIdByType.select}`, { value: "B" });
      expect(putRes.statusCode).toBe(200);

      const patchRes = await owner.patch(`${fieldsUrl()}/${fieldIdByType.select}`, { options: ["A", "C"] });
      expect(patchRes.statusCode).toBe(200);

      // (a) the stored row still exists, unchanged.
      const row = await prisma.customFieldValue.findUnique({
        where: { taskId_fieldId: { taskId, fieldId: fieldIdByType.select } },
      });
      expect(row?.value).toBe("B");

      // (b) the value read endpoint reports it as stale.
      const getRes = await owner.get(valuesUrl());
      const values = getRes.json().values as Array<{ fieldId: string; stale: boolean }>;
      const staleValue = values.find((v) => v.fieldId === fieldIdByType.select);
      expect(staleValue?.stale).toBe(true);

      // (c) writing "B" again now fails — it's no longer a valid option.
      const rewriteStale = await owner.put(`${valuesUrl()}/${fieldIdByType.select}`, { value: "B" });
      expect(rewriteStale.statusCode).toBe(422);

      // (d) writing a still-valid option succeeds and clears the stale flag.
      const rewriteValid = await owner.put(`${valuesUrl()}/${fieldIdByType.select}`, { value: "C" });
      expect(rewriteValid.statusCode).toBe(200);

      const getAfter = await owner.get(valuesUrl());
      const valuesAfter = getAfter.json().values as Array<{ fieldId: string; stale: boolean }>;
      const freshValue = valuesAfter.find((v) => v.fieldId === fieldIdByType.select);
      expect(freshValue?.stale).toBe(false);
    });

    it("cross-project value write: a field from project B against a task in project A is 404, no row created", async () => {
      const projectB = await createProjectAs(owner, workspaceId, "Project B");
      const fieldBRes = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${projectB.id}/custom-fields`,
        { name: "Cross Field", type: "text" },
      );
      const fieldBId = fieldBRes.json().field.id;

      const res = await owner.put(`${valuesUrl()}/${fieldBId}`, { value: "hostile write" });
      expect(res.statusCode).toBe(404);

      const count = await prisma.customFieldValue.count({ where: { fieldId: fieldBId } });
      expect(count).toBe(0);
    });
  });
});
