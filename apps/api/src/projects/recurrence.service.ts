import { occurrenceAt, parseRecurrenceRule } from "@projecthub/shared";
import { logger } from "../core/logger.js";
import { prisma } from "../core/prisma.js";
import { claimOne, type PollContext, type ScheduledPollHandler } from "../core/scheduler.js";
import { emitToCategory } from "../realtime/realtime.js";
import { createTask } from "./tasks.service.js";
import { serializeTask } from "./task-serialization.js";

export const RECURRENCE_MAX_TEMPLATES_PER_TICK = 100;

export const recurringTasksHandler: ScheduledPollHandler = {
  name: "recurring-tasks",
  run: spawnDueRecurrences,
};

/**
 * Every poll tick: find due recurrence templates (nextRunAt <= now, and only
 * genuine templates — never a subtask, never a spawned instance), atomically
 * claim each one via a compare-and-swap on (nextRunAt, recurrenceCount), then
 * spawn a concrete Task via the existing createTask() service path (so
 * activity events + the task.created broadcast fire exactly as they would
 * for a human-created task) and advance the template to its next occurrence
 * (or exhaust it to nextRunAt: null once its end condition is reached).
 *
 * The claim IS the (nextRunAt, recurrenceCount) -> (next, recurrenceCount+1)
 * write, computed BEFORE calling createTask, because the next occurrence is
 * derivable from (rule, recurrenceCount) with zero I/O — there is no
 * separate "claimedAt" marker column. This means a crash between the claim
 * and createTask succeeding silently skips exactly one occurrence (an
 * accepted, documented v1 tradeoff) rather than leaving the template
 * claimed-forever or double-spawning: the row's own (nextRunAt,
 * recurrenceCount) is never an intermediate/lease state, only ever a real
 * occurrence instant or a genuinely-advanced count, so the next poll tick's
 * findMany naturally either sees it as due again (crash before the CAS
 * committed) or moved on (CAS committed, spawn crashed) — never stuck.
 */
export async function spawnDueRecurrences(ctx: PollContext): Promise<void> {
  const candidates = await prisma.task.findMany({
    where: { nextRunAt: { lte: ctx.now }, parentTaskId: null, recurrenceTemplateId: null },
    select: {
      id: true,
      workspaceId: true,
      projectId: true,
      categoryId: true,
      creatorId: true,
      title: true,
      description: true,
      priority: true,
      recurrenceRule: true,
      recurrenceCount: true,
      nextRunAt: true,
    },
    orderBy: { nextRunAt: "asc" },
    take: RECURRENCE_MAX_TEMPLATES_PER_TICK,
  });

  for (const t of candidates) {
    try {
      const dueAt = t.nextRunAt!;
      const rule = parseRecurrenceRule(t.recurrenceRule);
      if (!rule) {
        logger.warn(
          { templateTaskId: t.id },
          "Unparseable recurrenceRule on a due template — disabling its recurrence",
        );
        await claimOne(() =>
          prisma.task.updateMany({ where: { id: t.id, nextRunAt: dueAt }, data: { nextRunAt: null } }),
        );
        continue;
      }

      const nextIndex = t.recurrenceCount + 1;
      let next: Date | null = occurrenceAt(rule, nextIndex);
      if (rule.count != null && nextIndex >= rule.count) next = null;
      if (rule.until != null && next != null && next > new Date(rule.until)) next = null;

      const won = await claimOne(() =>
        prisma.task.updateMany({
          where: {
            id: t.id,
            nextRunAt: dueAt,
            recurrenceCount: t.recurrenceCount,
            parentTaskId: null,
            recurrenceTemplateId: null,
          },
          data: { nextRunAt: next, recurrenceCount: { increment: 1 } },
        }),
      );
      if (!won) continue;

      const creator = await prisma.user.findUnique({ where: { id: t.creatorId }, select: { displayName: true } });
      const spawned = await createTask({
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        categoryId: t.categoryId,
        creatorId: t.creatorId,
        creatorDisplayName: creator?.displayName ?? "Unknown",
        recurrenceTemplateId: t.id,
        input: { title: t.title, description: t.description ?? undefined, priority: t.priority, dueDate: dueAt },
      });

      emitToCategory(t.categoryId, "task.created", serializeTask(spawned));
    } catch (err) {
      logger.error({ err, templateTaskId: t.id, instanceId: ctx.instanceId }, "Recurring task spawn failed");
    }
  }
}
