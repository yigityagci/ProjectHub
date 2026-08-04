import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/core/prisma.js";
import { Scheduler, getScheduler, type PollContext } from "../src/core/scheduler.js";
import { sendDueDateReminders, dueDateReminderHandler } from "../src/notifications/due-date-reminder.service.js";
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

/** Mirrors recurring-tasks.test.ts's own `waitUntil`. */
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

function isoSecondsFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

const LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

describe("Due-date reminder emails (schema, scheduler handler, preference gating)", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;
  let projectId: string;
  let categoryId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    // This app's OWN registered scheduler polls on a real interval and would
    // otherwise race with this file's deliberately precise, manually-ticked
    // assertions below. Every test in this file drives its own standalone
    // `Scheduler` instance instead, so the app's background one is stopped
    // immediately and never used.
    await getScheduler()?.stop();

    owner = await registerAndLogin(app, "owner@example.com");
    const ws = await createWorkspaceAs(owner, "Due Date Co", "due-date-co");
    workspaceId = ws.id;
    const project = await createProjectAs(owner, workspaceId, "Due Date Project");
    projectId = project.id;
    const category = await createCategoryAs(owner, workspaceId, projectId, "Default");
    categoryId = category.id;
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

  async function assign(taskId: string, userId: string) {
    const res = await owner.post(`${base()}/tasks/${taskId}/assignees`, { userId });
    if (res.statusCode !== 201) throw new Error(`Assign failed: ${res.statusCode} ${res.body}`);
  }

  /**
   * Fetches due_date_soon notifications for a given task by plain
   * `type`-scoped findMany + in-JS payload filter — avoids depending on
   * Postgres JSON-path query syntax (untested elsewhere in this codebase)
   * for what is otherwise a simple assertion.
   */
  async function notificationsForTask(taskId: string, recipientUserId?: string) {
    const notifications = await prisma.notification.findMany({
      where: { type: "due_date_soon", ...(recipientUserId ? { recipientUserId } : {}) },
    });
    return notifications.filter((n) => (n.payload as { taskId?: string }).taskId === taskId);
  }

  it("(a) exactly one winner among 5 concurrent claim attempts on the same due task", async () => {
    const task = await createTask("Concurrent due task", { dueDate: isoSecondsFromNow(30) });
    const member = await inviteAndAccept(app, owner, workspaceId, "concurrency-member@example.com", "MEMBER");
    const memberId = await getMemberUserId(owner, workspaceId, "concurrency-member@example.com");
    await assign(task.id, memberId);

    const ctx: PollContext = { now: new Date(), instanceId: "concurrency-test" };
    await Promise.all([
      sendDueDateReminders(ctx),
      sendDueDateReminders(ctx),
      sendDueDateReminders(ctx),
      sendDueDateReminders(ctx),
      sendDueDateReminders(ctx),
    ]);

    const notifications = await prisma.notification.findMany({
      where: { recipientUserId: memberId, type: "due_date_soon" },
    });
    expect(notifications.length).toBe(1);

    const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.dueReminderSentAt).not.toBeNull();
    void member;
  });

  it("(b) end-to-end poller integration: reminds exactly once for the in-window task; the out-of-window sibling stays untouched", async () => {
    const inWindowTask = await createTask("In-window task", { dueDate: isoSecondsFromNow(20) });
    const outOfWindowTask = await createTask("Out-of-window task", {
      dueDate: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    });
    const member = await inviteAndAccept(app, owner, workspaceId, "poller-member@example.com", "MEMBER");
    const memberId = await getMemberUserId(owner, workspaceId, "poller-member@example.com");
    await assign(inWindowTask.id, memberId);
    await assign(outOfWindowTask.id, memberId);

    const scheduler = new Scheduler({ intervalMs: 20, handlers: [dueDateReminderHandler] });
    try {
      scheduler.start();
      await waitUntil(async () => (await prisma.task.findUniqueOrThrow({ where: { id: inWindowTask.id } })).dueReminderSentAt !== null);

      // Give a few more ticks a chance to run, to prove it isn't re-claimed / double-sent.
      await sleep(150);

      const notifs = await notificationsForTask(inWindowTask.id, memberId);
      expect(notifs.length).toBe(1);

      const outOfWindowUpdated = await prisma.task.findUniqueOrThrow({ where: { id: outOfWindowTask.id } });
      expect(outOfWindowUpdated.dueReminderSentAt).toBeNull();
      const outOfWindowNotifs = await notificationsForTask(outOfWindowTask.id, memberId);
      expect(outOfWindowNotifs.length).toBe(0);
    } finally {
      await scheduler.stop();
    }
  });

  it("(c) boundary precision: strict lower bound (now), inclusive upper bound (now+lookahead), and overdue tasks never match", async () => {
    const now = new Date();
    const exactlyNow = await createTask("Exactly-now boundary", { dueDate: now.toISOString() });
    const exactlyWindowEnd = await createTask("Exactly-window-end boundary", {
      dueDate: new Date(now.getTime() + LOOKAHEAD_MS).toISOString(),
    });
    const pastWindowEnd = await createTask("Past-window-end boundary", {
      dueDate: new Date(now.getTime() + LOOKAHEAD_MS + 1000).toISOString(),
    });
    const overdue = await createTask("Already-overdue boundary", { dueDate: isoSecondsAgo(30) });

    // Force these directly via Prisma to test exact boundary values (the
    // create-task input schema may round-trip differently), and clear
    // dueReminderSentAt so all four are freshly eligible-or-not per their
    // dueDate alone.
    await prisma.task.update({ where: { id: exactlyNow.id }, data: { dueDate: now, dueReminderSentAt: null } });
    await prisma.task.update({
      where: { id: exactlyWindowEnd.id },
      data: { dueDate: new Date(now.getTime() + LOOKAHEAD_MS), dueReminderSentAt: null },
    });
    await prisma.task.update({
      where: { id: pastWindowEnd.id },
      data: { dueDate: new Date(now.getTime() + LOOKAHEAD_MS + 1000), dueReminderSentAt: null },
    });
    await prisma.task.update({ where: { id: overdue.id }, data: { dueReminderSentAt: null } });

    const ctx: PollContext = { now, instanceId: "boundary-test" };
    await sendDueDateReminders(ctx);

    const after = await prisma.task.findMany({
      where: { id: { in: [exactlyNow.id, exactlyWindowEnd.id, pastWindowEnd.id, overdue.id] } },
    });
    const byId = new Map(after.map((t) => [t.id, t]));
    expect(byId.get(exactlyNow.id)!.dueReminderSentAt).toBeNull();
    expect(byId.get(exactlyWindowEnd.id)!.dueReminderSentAt).not.toBeNull();
    expect(byId.get(pastWindowEnd.id)!.dueReminderSentAt).toBeNull();
    expect(byId.get(overdue.id)!.dueReminderSentAt).toBeNull();
  });

  it("(d) fan-out + independent per-assignee preference gating; a 0-assignee task creates 0 notifications and never throws", async () => {
    const optedIn = await inviteAndAccept(app, owner, workspaceId, "opted-in@example.com", "MEMBER");
    const optedInId = await getMemberUserId(owner, workspaceId, "opted-in@example.com");
    const optedOut = await inviteAndAccept(app, owner, workspaceId, "opted-out@example.com", "MEMBER");
    const optedOutId = await getMemberUserId(owner, workspaceId, "opted-out@example.com");

    const optOutRes = await optedOut.patch("/api/auth/me/preferences", { notifications: { due_date_soon: false } });
    expect(optOutRes.statusCode).toBe(200);
    expect(optOutRes.json().user.notifications.due_date_soon).toBe(false);

    const task = await createTask("Fan-out task", { dueDate: isoSecondsFromNow(15) });
    await assign(task.id, optedInId);
    await assign(task.id, optedOutId);

    const noAssigneeTask = await createTask("No-assignee task", { dueDate: isoSecondsFromNow(15) });

    const ctx: PollContext = { now: new Date(), instanceId: "fanout-test" };
    await expect(sendDueDateReminders(ctx)).resolves.not.toThrow();

    const notifications = await notificationsForTask(task.id);
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.recipientUserId).toBe(optedInId);

    const noAssigneeNotifs = await notificationsForTask(noAssigneeTask.id);
    expect(noAssigneeNotifs.length).toBe(0);

    const updatedNoAssignee = await prisma.task.findUniqueOrThrow({ where: { id: noAssigneeTask.id } });
    expect(updatedNoAssignee.dueReminderSentAt).not.toBeNull();

    void optedIn;
  });

  it("(e) idempotency across ticks: no additional Notification rows after a successful send", async () => {
    const task = await createTask("Idempotency task", { dueDate: isoSecondsFromNow(15) });
    const member = await inviteAndAccept(app, owner, workspaceId, "idempotency-member@example.com", "MEMBER");
    const memberId = await getMemberUserId(owner, workspaceId, "idempotency-member@example.com");
    await assign(task.id, memberId);

    const scheduler = new Scheduler({ intervalMs: 20, handlers: [dueDateReminderHandler] });
    try {
      scheduler.start();
      await waitUntil(async () => (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).dueReminderSentAt !== null);

      // Give a few more ticks a chance to run, to prove no double-send.
      await sleep(150);

      const notifs = await notificationsForTask(task.id, memberId);
      expect(notifs.length).toBe(1);
    } finally {
      await scheduler.stop();
    }
  });

  it("(f) a dueDate edit clears dueReminderSentAt regardless of PATCH shape, re-arming eligibility", async () => {
    const task = await createTask("Re-arm task", { dueDate: isoSecondsFromNow(15) });
    const member = await inviteAndAccept(app, owner, workspaceId, "rearm-member@example.com", "MEMBER");
    const memberId = await getMemberUserId(owner, workspaceId, "rearm-member@example.com");
    await assign(task.id, memberId);

    const ctx: PollContext = { now: new Date(), instanceId: "rearm-test" };
    await sendDueDateReminders(ctx);

    let current = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(current.dueReminderSentAt).not.toBeNull();

    // (i) A genuinely new dueDate.
    let patchRes = await patchTask(task.id, { version: current.version, dueDate: isoSecondsFromNow(999) });
    expect(patchRes.statusCode).toBe(200);
    current = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(current.dueReminderSentAt).toBeNull();

    // Simulate "already sent" again (direct write, bypassing the scheduler),
    // then (ii) re-send the exact same dueDate value already stored.
    await prisma.task.update({ where: { id: task.id }, data: { dueReminderSentAt: new Date() } });
    current = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(current.dueReminderSentAt).not.toBeNull();

    patchRes = await patchTask(task.id, { version: current.version, dueDate: current.dueDate!.toISOString() });
    expect(patchRes.statusCode).toBe(200);
    current = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(current.dueReminderSentAt).toBeNull();

    // Simulate "already sent" once more, then (iii) clear dueDate to null.
    await prisma.task.update({ where: { id: task.id }, data: { dueReminderSentAt: new Date() } });
    current = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(current.dueReminderSentAt).not.toBeNull();

    patchRes = await patchTask(task.id, { version: current.version, dueDate: null });
    expect(patchRes.statusCode).toBe(200);
    current = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(current.dueReminderSentAt).toBeNull();
    expect(current.dueDate).toBeNull();

    // Re-set dueDate back into the lookahead window and confirm a fresh reminder fires on the next tick.
    patchRes = await patchTask(task.id, { version: current.version, dueDate: isoSecondsFromNow(10) });
    expect(patchRes.statusCode).toBe(200);
    current = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(current.dueReminderSentAt).toBeNull();

    await sendDueDateReminders({ now: new Date(), instanceId: "rearm-test-final" });
    current = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(current.dueReminderSentAt).not.toBeNull();

    void member;
  });

  it("(g) email-content sanity: the actor-less due_date_soon branch produces a sensible subject/body with no 'undefined' and no actor reference", async () => {
    const task = await createTask("Email sanity task", { dueDate: isoSecondsFromNow(15) });
    const member = await inviteAndAccept(app, owner, workspaceId, "email-sanity-member@example.com", "MEMBER");
    const memberId = await getMemberUserId(owner, workspaceId, "email-sanity-member@example.com");
    await assign(task.id, memberId);

    const logs: string[] = [];
    const originalLog = console.log;
    // eslint-disable-next-line no-console
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    try {
      await sendDueDateReminders({ now: new Date(), instanceId: "email-sanity-test" });
      // Give the fire-and-forget email hook inside createNotification a
      // moment to run and log before we inspect captured output.
      await sleep(100);
    } finally {
      console.log = originalLog;
    }

    const joined = logs.join("\n");
    expect(joined).toContain("Email sanity task");
    expect(joined.toLowerCase()).not.toContain("undefined");
    void member;
  });

  it("(h) notifyOnDueDate: false on the sole assignee -> no Notification row, no throw", async () => {
    const optedOut = await inviteAndAccept(app, owner, workspaceId, "sole-opted-out@example.com", "MEMBER");
    const optedOutId = await getMemberUserId(owner, workspaceId, "sole-opted-out@example.com");
    const optOutRes = await optedOut.patch("/api/auth/me/preferences", { notifications: { due_date_soon: false } });
    expect(optOutRes.statusCode).toBe(200);

    const task = await createTask("Sole-opted-out task", { dueDate: isoSecondsFromNow(15) });
    await assign(task.id, optedOutId);

    await expect(sendDueDateReminders({ now: new Date(), instanceId: "sole-opted-out-test" })).resolves.not.toThrow();

    const notifs = await notificationsForTask(task.id, optedOutId);
    expect(notifs.length).toBe(0);

    const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.dueReminderSentAt).not.toBeNull();
  });
});
