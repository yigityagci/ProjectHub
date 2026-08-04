import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { occurrenceAt, parseRecurrenceRule, type RecurrenceRule } from "@projecthub/shared";
import { prisma } from "../src/core/prisma.js";
import { Scheduler, getScheduler, type PollContext } from "../src/core/scheduler.js";
import { spawnDueRecurrences, recurringTasksHandler } from "../src/projects/recurrence.service.js";
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

/**
 * Bounded-wait helper, mirroring scheduler.test.ts's own `waitUntil` — but
 * this file's conditions are DB-backed (has an instance been spawned yet?),
 * so the predicate is allowed to be async here.
 */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitUntil: timed out waiting for condition");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

describe("Recurring tasks (schema, scheduler handler, HTTP eligibility rules)", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;
  let projectId: string;
  let categoryId: string;
  let firstColumnId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    // This app's OWN registered scheduler polls on a real interval
    // (SCHEDULER_POLL_INTERVAL_MS) and would otherwise race with this file's
    // deliberately precise, manually-ticked assertions below (a background
    // tick firing at an unpredictable moment mid-test). Every test in this
    // file drives its own standalone `Scheduler` instance instead, so the
    // app's background one is stopped immediately and never used.
    await getScheduler()?.stop();

    owner = await registerAndLogin(app, "owner@example.com");
    const ws = await createWorkspaceAs(owner, "Recurrence Co", "recurrence-co");
    workspaceId = ws.id;
    const project = await createProjectAs(owner, workspaceId, "Recurrence Project");
    projectId = project.id;
    const category = await createCategoryAs(owner, workspaceId, projectId, "Default");
    categoryId = category.id;

    const columnsRes = await owner.get(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/columns`,
    );
    const columns = columnsRes.json().columns as Array<{ id: string; position: number }>;
    firstColumnId = columns.slice().sort((a, b) => a.position - b.position)[0]!.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  function base(): string {
    return `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}`;
  }

  async function createTask(title: string, extra: Record<string, unknown> = {}): Promise<{ id: string; version: number } & Record<string, unknown>> {
    const res = await owner.post(`${base()}/tasks`, { title, ...extra });
    if (res.statusCode !== 201) throw new Error(`Create task failed: ${res.statusCode} ${res.body}`);
    return res.json().task;
  }

  function patchTask(taskId: string, body: Record<string, unknown>) {
    return owner.patch(`${base()}/tasks/${taskId}`, body);
  }

  it("(a) exactly one winner among 5 concurrent claim attempts on the same due template", async () => {
    const template = await createTask("Concurrent recurring template");
    const rule = { freq: "daily" as const, interval: 1, startAt: isoSecondsAgo(30) };
    const patchRes = await patchTask(template.id, { version: template.version, recurrenceRule: rule });
    expect(patchRes.statusCode).toBe(200);

    const ctx: PollContext = { now: new Date(), instanceId: "concurrency-test" };
    // Genuinely concurrent: 5 in-flight spawnDueRecurrences calls fired
    // together via Promise.all, racing on the same due template's claim.
    await Promise.all([
      spawnDueRecurrences(ctx),
      spawnDueRecurrences(ctx),
      spawnDueRecurrences(ctx),
      spawnDueRecurrences(ctx),
      spawnDueRecurrences(ctx),
    ]);

    const instances = await prisma.task.findMany({ where: { recurrenceTemplateId: template.id } });
    expect(instances.length).toBe(1);

    const updatedTemplate = await prisma.task.findUniqueOrThrow({ where: { id: template.id } });
    expect(updatedTemplate.recurrenceCount).toBe(1);
  });

  it("(b) end-to-end poller integration: spawns exactly once for the due template; the not-yet-due sibling stays untouched", async () => {
    const dueTemplate = await createTask("Due template");
    const futureTemplate = await createTask("Future template");

    const dueRule = { freq: "daily" as const, interval: 1, startAt: isoSecondsAgo(20) };
    const futureRule = {
      freq: "daily" as const,
      interval: 1,
      startAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    expect((await patchTask(dueTemplate.id, { version: dueTemplate.version, recurrenceRule: dueRule })).statusCode).toBe(200);
    expect(
      (await patchTask(futureTemplate.id, { version: futureTemplate.version, recurrenceRule: futureRule })).statusCode,
    ).toBe(200);

    const scheduler = new Scheduler({ intervalMs: 20, handlers: [recurringTasksHandler] });
    try {
      scheduler.start();
      await waitUntil(async () => (await prisma.task.count({ where: { recurrenceTemplateId: dueTemplate.id } })) === 1);

      // Give a few more ticks a chance to run, to prove it isn't re-claimed
      // / double-spawned.
      await sleep(150);

      const instances = await prisma.task.count({ where: { recurrenceTemplateId: dueTemplate.id } });
      expect(instances).toBe(1);

      const updatedFuture = await prisma.task.findUniqueOrThrow({ where: { id: futureTemplate.id } });
      expect(updatedFuture.recurrenceCount).toBe(0);
      const futureInstances = await prisma.task.count({ where: { recurrenceTemplateId: futureTemplate.id } });
      expect(futureInstances).toBe(0);
    } finally {
      await scheduler.stop();
    }
  });

  it("(c) a single tick on a daily interval-1 rule advances nextRunAt to exactly occurrenceAt(rule, 1) and recurrenceCount to 1", async () => {
    const template = await createTask("Daily determinism template");
    const rule: RecurrenceRule = { freq: "daily", interval: 1, startAt: isoSecondsAgo(15) };
    const patchRes = await patchTask(template.id, { version: template.version, recurrenceRule: rule });
    expect(patchRes.statusCode).toBe(200);

    const scheduler = new Scheduler({ intervalMs: 999999, handlers: [recurringTasksHandler] });
    try {
      await scheduler.runOnce();
    } finally {
      await scheduler.stop();
    }

    const updated = await prisma.task.findUniqueOrThrow({ where: { id: template.id } });
    expect(updated.recurrenceCount).toBe(1);
    expect(updated.nextRunAt?.getTime()).toBe(occurrenceAt(rule, 1).getTime());
  });

  it("(d) monthly recurrence is anchored to startAt every time (no drift): Jan 31 -> Feb 28 -> Mar 31", async () => {
    const template = await createTask("Monthly clamp template");
    // A historical anchor, deliberately more than 24h in the past — the
    // client-facing recurrenceRuleInputSchema would reject this via the
    // real PATCH endpoint, so this is written directly, exercising the
    // STORED-rule schema's lack of any now-relative check (recurrenceRuleSchema,
    // not recurrenceRuleInputSchema).
    const rule: RecurrenceRule = { freq: "monthly", interval: 1, startAt: "2023-01-31T00:00:00.000Z", until: null, count: null };
    await prisma.task.update({
      where: { id: template.id },
      data: { recurrenceRule: rule, nextRunAt: new Date(rule.startAt), recurrenceCount: 0 },
    });

    const scheduler = new Scheduler({ intervalMs: 999999, handlers: [recurringTasksHandler] });
    try {
      await scheduler.runOnce();
      const afterFirst = await prisma.task.findUniqueOrThrow({ where: { id: template.id } });
      expect(afterFirst.recurrenceCount).toBe(1);
      expect(afterFirst.nextRunAt?.toISOString().slice(0, 10)).toBe("2023-02-28");

      await scheduler.runOnce();
      const afterSecond = await prisma.task.findUniqueOrThrow({ where: { id: template.id } });
      expect(afterSecond.recurrenceCount).toBe(2);
      expect(afterSecond.nextRunAt?.toISOString().slice(0, 10)).toBe("2023-03-31");
    } finally {
      await scheduler.stop();
      // This historical-anchor template would otherwise remain perpetually
      // "due" (its nextRunAt is deep in the past relative to the real
      // clock) and get re-picked-up by every later test's scheduler ticks.
      await prisma.task.update({ where: { id: template.id }, data: { nextRunAt: null } });
    }

    const instances = await prisma.task.findMany({
      where: { recurrenceTemplateId: template.id },
      orderBy: { dueDate: "asc" },
    });
    expect(instances.length).toBe(2);
    expect(instances[0]!.dueDate?.toISOString().slice(0, 10)).toBe("2023-01-31");
    expect(instances[1]!.dueDate?.toISOString().slice(0, 10)).toBe("2023-02-28");
  });

  it("(e) exhaustion by count: stops advancing after 2 spawns (nextRunAt null on the 2nd claim); a further tick spawns nothing more", async () => {
    const template = await createTask("Count-exhaustion template");
    // Anchored far enough in the past (written directly, same rationale as
    // test (d)) that BOTH the 1st and 2nd occurrence are already due,
    // letting two sequential runOnce() calls exercise both claims without
    // any artificial clock manipulation.
    const startAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const rule: RecurrenceRule = { freq: "daily", interval: 1, startAt, until: null, count: 2 };
    await prisma.task.update({
      where: { id: template.id },
      data: { recurrenceRule: rule, nextRunAt: new Date(rule.startAt), recurrenceCount: 0 },
    });

    const scheduler = new Scheduler({ intervalMs: 999999, handlers: [recurringTasksHandler] });
    try {
      await scheduler.runOnce();
      const afterFirst = await prisma.task.findUniqueOrThrow({ where: { id: template.id } });
      expect(afterFirst.recurrenceCount).toBe(1);
      expect(afterFirst.nextRunAt).not.toBeNull();

      await scheduler.runOnce();
      const afterSecond = await prisma.task.findUniqueOrThrow({ where: { id: template.id } });
      expect(afterSecond.recurrenceCount).toBe(2);
      expect(afterSecond.nextRunAt).toBeNull();

      await scheduler.runOnce();
      const afterThird = await prisma.task.findUniqueOrThrow({ where: { id: template.id } });
      expect(afterThird.recurrenceCount).toBe(2);
    } finally {
      await scheduler.stop();
    }

    const instanceCount = await prisma.task.count({ where: { recurrenceTemplateId: template.id } });
    expect(instanceCount).toBe(2);
  });

  it("(f) exhaustion by date: nextRunAt becomes null after the 1st spawn when the 2nd occurrence would fall after `until`", async () => {
    const template = await createTask("Date-exhaustion template");
    const startAt = isoSecondsAgo(20);
    const until = new Date(new Date(startAt).getTime() + 12 * 60 * 60 * 1000).toISOString();
    const rule: RecurrenceRule = { freq: "daily", interval: 1, startAt, until };
    const patchRes = await patchTask(template.id, { version: template.version, recurrenceRule: rule });
    expect(patchRes.statusCode).toBe(200);

    const scheduler = new Scheduler({ intervalMs: 999999, handlers: [recurringTasksHandler] });
    try {
      await scheduler.runOnce();
    } finally {
      await scheduler.stop();
    }

    const updated = await prisma.task.findUniqueOrThrow({ where: { id: template.id } });
    expect(updated.recurrenceCount).toBe(1);
    expect(updated.nextRunAt).toBeNull();

    const instanceCount = await prisma.task.count({ where: { recurrenceTemplateId: template.id } });
    expect(instanceCount).toBe(1);
  });

  it("(g) a spawned instance has the expected shape", async () => {
    const template = await createTask("Shape template", { priority: "high" });
    const startAt = isoSecondsAgo(10);
    const patchRes = await patchTask(template.id, {
      version: template.version,
      recurrenceRule: { freq: "weekly", interval: 1, startAt },
    });
    expect(patchRes.statusCode).toBe(200);

    const scheduler = new Scheduler({ intervalMs: 999999, handlers: [recurringTasksHandler] });
    try {
      await scheduler.runOnce();
    } finally {
      await scheduler.stop();
    }

    const instance = await prisma.task.findFirstOrThrow({ where: { recurrenceTemplateId: template.id } });
    expect(instance.recurrenceTemplateId).toBe(template.id);
    expect(parseRecurrenceRule(instance.recurrenceRule)).toBeNull();
    expect(instance.nextRunAt).toBeNull();
    expect(instance.parentTaskId).toBeNull();
    expect(instance.columnId).toBe(firstColumnId);
    expect(instance.dueDate?.toISOString()).toBe(new Date(startAt).toISOString());
  });

  describe("(h) eligibility rejections (422)", () => {
    it("a subtask cannot have recurrenceRule set", async () => {
      const parent = await createTask("Eligibility parent");
      const child = await createTask("Eligibility child");
      const nestRes = await patchTask(child.id, { version: child.version, parentTaskId: parent.id });
      expect(nestRes.statusCode).toBe(200);
      const nested = nestRes.json().task;

      const res = await patchTask(child.id, {
        version: nested.version,
        recurrenceRule: { freq: "daily", interval: 1, startAt: isoSecondsAgo(5) },
      });
      expect(res.statusCode).toBe(422);
    });

    it("a spawned instance cannot have recurrenceRule set", async () => {
      const template = await createTask("Instance-eligibility template");
      const patchRes = await patchTask(template.id, {
        version: template.version,
        recurrenceRule: { freq: "daily", interval: 1, startAt: isoSecondsAgo(10) },
      });
      expect(patchRes.statusCode).toBe(200);

      const scheduler = new Scheduler({ intervalMs: 999999, handlers: [recurringTasksHandler] });
      try {
        await scheduler.runOnce();
      } finally {
        await scheduler.stop();
      }

      const instance = await prisma.task.findFirstOrThrow({ where: { recurrenceTemplateId: template.id } });
      const res = await patchTask(instance.id, {
        version: instance.version,
        recurrenceRule: { freq: "daily", interval: 1, startAt: isoSecondsAgo(5) },
      });
      expect(res.statusCode).toBe(422);
    });

    it("a task with a recurrence rule already set cannot be given a parentTaskId in a PATCH that doesn't also clear the rule", async () => {
      const recurringTask = await createTask("Already recurring");
      const ruleRes = await patchTask(recurringTask.id, {
        version: recurringTask.version,
        recurrenceRule: { freq: "daily", interval: 1, startAt: isoSecondsAgo(5) },
      });
      expect(ruleRes.statusCode).toBe(200);
      const afterRulePatch = ruleRes.json().task;

      const wouldBeParent = await createTask("Would-be parent");

      const res = await patchTask(recurringTask.id, {
        version: afterRulePatch.version,
        parentTaskId: wouldBeParent.id,
      });
      expect(res.statusCode).toBe(422);
    });
  });

  it("(i) client-supplied nextRunAt is rejected 422 by the strict update schema", async () => {
    const task = await createTask("Allowlist closure task");
    const res = await patchTask(task.id, { version: task.version, nextRunAt: "2099-01-01T00:00:00.000Z" });
    expect(res.statusCode).toBe(422);
  });

  it("(j) deleting a template SetNulls recurrenceTemplateId on its already-spawned instances, rather than cascading", async () => {
    const template = await createTask("Deletable template");
    const patchRes = await patchTask(template.id, {
      version: template.version,
      recurrenceRule: { freq: "daily", interval: 1, startAt: isoSecondsAgo(10) },
    });
    expect(patchRes.statusCode).toBe(200);

    const scheduler = new Scheduler({ intervalMs: 999999, handlers: [recurringTasksHandler] });
    try {
      await scheduler.runOnce();
    } finally {
      await scheduler.stop();
    }

    const instance = await prisma.task.findFirstOrThrow({ where: { recurrenceTemplateId: template.id } });

    const deleteRes = await owner.delete(`${base()}/tasks/${template.id}`);
    expect(deleteRes.statusCode).toBe(200);

    const survived = await prisma.task.findUniqueOrThrow({ where: { id: instance.id } });
    expect(survived.recurrenceTemplateId).toBeNull();
  });
});
