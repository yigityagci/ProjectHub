import { prisma } from "../core/prisma.js";
import { logger } from "../core/logger.js";
import { claimOne, type PollContext, type ScheduledPollHandler } from "../core/scheduler.js";
import { createNotification } from "./notifications.service.js";

/** v1: a single fixed lookahead window, not configurable per-user/per-task yet. */
export const DUE_DATE_REMINDER_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;
export const DUE_DATE_REMINDER_MAX_TASKS_PER_TICK = 200;

export const dueDateReminderHandler: ScheduledPollHandler = {
  name: "due-date-reminders",
  run: sendDueDateReminders,
};

/**
 * Every poll tick: find tasks whose dueDate falls strictly within
 * (now, now + lookahead] and that have never been reminded
 * (dueReminderSentAt IS NULL), atomically claim each one via a CAS on
 * dueReminderSentAt (the SAME write IS the claim — there's no separate
 * "next occurrence" to compute, unlike recurrence.service.ts), then create a
 * real Notification per assignee via the existing createNotification (which
 * independently gates each recipient's own notifyOnDueDate preference and
 * fires the email hook once notification-email.ts's due_date_soon branch is
 * in place).
 *
 * A task already overdue when the poller catches up (e.g. after downtime)
 * is deliberately left untouched — dueDate > now is a strict lower bound —
 * because "your task is due soon" is actively misleading messaging once a
 * task is already late, unlike Recurring Tasks' catch-up semantics (where a
 * missed occurrence still needs to be spawned because the work item itself
 * must exist).
 */
export async function sendDueDateReminders(ctx: PollContext): Promise<void> {
  const windowEnd = new Date(ctx.now.getTime() + DUE_DATE_REMINDER_LOOKAHEAD_MS);

  const candidates = await prisma.task.findMany({
    where: { dueDate: { gt: ctx.now, lte: windowEnd }, dueReminderSentAt: null },
    select: {
      id: true,
      workspaceId: true,
      projectId: true,
      categoryId: true,
      dueDate: true,
      assignees: { select: { userId: true } },
    },
    orderBy: { dueDate: "asc" },
    take: DUE_DATE_REMINDER_MAX_TASKS_PER_TICK,
  });

  for (const t of candidates) {
    try {
      const won = await claimOne(() =>
        prisma.task.updateMany({
          where: { id: t.id, dueReminderSentAt: null, dueDate: { gt: ctx.now, lte: windowEnd } },
          data: { dueReminderSentAt: ctx.now },
        }),
      );
      if (!won) continue;

      for (const { userId } of t.assignees) {
        await createNotification({
          workspaceId: t.workspaceId,
          recipientUserId: userId,
          type: "due_date_soon",
          payload: { taskId: t.id, projectId: t.projectId, categoryId: t.categoryId },
        });
      }
    } catch (err) {
      logger.error({ err, taskId: t.id, instanceId: ctx.instanceId }, "Due-date reminder send failed");
    }
  }
}
