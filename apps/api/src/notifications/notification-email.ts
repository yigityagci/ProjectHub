import type { Notification } from "@prisma/client";
import { prisma } from "../core/prisma.js";
import { env } from "../config/env.js";
import { sendNotificationEmail } from "../email/email.service.js";

/**
 * Sends the email counterpart of an already-created, already-not-opted-out
 * Notification. Does its OWN targeted lookups rather than reading
 * denormalized text from notification.payload — the stored payload is raw
 * IDs only, and its shape is relied on by NotificationBell.tsx and by
 * existing tests, so it must NOT change.
 */
export async function sendNotificationEmailFor(
  notification: Notification,
  recipient: { email: string; displayName: string },
): Promise<void> {
  const payload = (notification.payload ?? {}) as {
    taskId?: string;
    projectId?: string;
    categoryId?: string;
    assignedBy?: string;
    authorId?: string;
  };

  // Defensive — payload is untyped JSON. No taskId means there's nothing
  // meaningful to link to or describe.
  if (!payload.taskId) return;

  if (notification.type === "due_date_soon") {
    const task = await prisma.task.findUnique({
      where: { id: payload.taskId },
      select: { title: true, dueDate: true, project: { select: { name: true } } },
    });
    if (!task || !task.dueDate) return;

    const link = payload.categoryId
      ? `${env.WEB_URL}/workspace/${notification.workspaceId}/projects/${payload.projectId}/categories/${payload.categoryId}/board`
      : `${env.WEB_URL}/workspace/${notification.workspaceId}/projects/${payload.projectId}/categories`;

    await sendNotificationEmail({
      recipientEmail: recipient.email,
      recipientDisplayName: recipient.displayName,
      type: notification.type,
      taskTitle: task.title,
      projectName: task.project.name,
      dueDate: task.dueDate,
      link,
    });
    return;
  }

  const actorId = notification.type === "mention" ? payload.authorId : payload.assignedBy;
  if (!actorId) return;

  const [task, actor] = await Promise.all([
    prisma.task.findUnique({
      where: { id: payload.taskId },
      select: { title: true, project: { select: { name: true } } },
    }),
    prisma.user.findUnique({ where: { id: actorId }, select: { displayName: true } }),
  ]);
  if (!task || !actor) return;

  const link = payload.categoryId
    ? `${env.WEB_URL}/workspace/${notification.workspaceId}/projects/${payload.projectId}/categories/${payload.categoryId}/board`
    : `${env.WEB_URL}/workspace/${notification.workspaceId}/projects/${payload.projectId}/categories`;

  await sendNotificationEmail({
    recipientEmail: recipient.email,
    recipientDisplayName: recipient.displayName,
    type: notification.type,
    actorDisplayName: actor.displayName,
    taskTitle: task.title,
    projectName: task.project.name,
    link,
  });
}
