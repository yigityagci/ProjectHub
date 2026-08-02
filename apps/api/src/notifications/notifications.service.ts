import type { NotificationType } from "@projecthub/shared";
import type { Notification } from "@prisma/client";
import { prisma } from "../core/prisma.js";
import { NotFoundError } from "../core/errors.js";
import { logger } from "../core/logger.js";
import { emitToUser } from "../realtime/realtime.js";
import { sendNotificationEmailFor } from "./notification-email.js";

export interface CreateNotificationInput {
  workspaceId: string;
  recipientUserId: string;
  type: NotificationType;
  payload?: Record<string, unknown>;
}

/**
 * Maps each NotificationType to the User preference column that gates it.
 * Load-bearing: this is a `Record<NotificationType, ...>`, not a partial map,
 * so adding a 4th NotificationType fails to compile here until it's wired to
 * a preference column — a future notification type can never ship silently
 * un-gate-able.
 */
const NOTIFICATION_PREF_FIELD: Record<
  NotificationType,
  "notifyOnMention" | "notifyOnTaskAssigned" | "notifyOnCommentReply"
> = {
  mention: "notifyOnMention",
  task_assigned: "notifyOnTaskAssigned",
  comment_reply: "notifyOnCommentReply",
};

function serializeNotification(n: {
  id: string;
  workspaceId: string;
  type: string;
  payload: unknown;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: n.id,
    workspaceId: n.workspaceId,
    type: n.type,
    payload: n.payload,
    readAt: n.readAt,
    createdAt: n.createdAt,
  };
}

/**
 * Creates a Notification row (after the triggering mutation has already
 * been persisted) and pushes it live to the recipient's own user-scoped
 * real-time room. Anyone not connected at delivery time picks it up later
 * via GET /api/notifications.
 *
 * The recipient's per-type preference gates creation itself (not read-time
 * filtering): an opted-out notification never becomes a row and never fires
 * a realtime event, so toggling a preference later never retroactively
 * rewrites history. Returns null (no row created) when the recipient has
 * opted out, or doesn't exist (a strict improvement over the previous
 * behavior, which would FK-violate).
 */
export async function createNotification(input: CreateNotificationInput): Promise<Notification | null> {
  const recipient = await prisma.user.findUnique({
    where: { id: input.recipientUserId },
    select: {
      notifyOnMention: true,
      notifyOnTaskAssigned: true,
      notifyOnCommentReply: true,
      email: true,
      displayName: true,
    },
  });
  if (!recipient) return null;

  const prefField = NOTIFICATION_PREF_FIELD[input.type];
  if (!recipient[prefField]) return null;

  const notification = await prisma.notification.create({
    data: {
      workspaceId: input.workspaceId,
      recipientUserId: input.recipientUserId,
      type: input.type,
      payload: (input.payload ?? {}) as object,
    },
  });

  emitToUser(input.recipientUserId, "notification.created", serializeNotification(notification));

  // Fire-and-forget: an SMTP timeout must never fail (or slow down) the
  // request that triggered the notification. Mirrors auth.routes.ts's
  // password-reset send exactly. Errors are NOT swallowed — they surface as
  // structured logger.error entries.
  void sendNotificationEmailFor(notification, recipient).catch((err) => {
    logger.error(
      { err, notificationId: notification.id, type: input.type, recipientUserId: input.recipientUserId },
      "Failed to send notification email",
    );
  });

  return notification;
}

export async function listNotificationsForUser(userId: string) {
  const notifications = await prisma.notification.findMany({
    where: { recipientUserId: userId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return notifications.map(serializeNotification);
}

export async function markNotificationRead(userId: string, notificationId: string) {
  // Scoped to recipientUserId so a caller can never confirm the existence
  // of — let alone mark as read — someone else's notification: 404, not
  // 403, for both "doesn't exist" and "exists but isn't yours".
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, recipientUserId: userId },
  });
  if (!notification) {
    throw new NotFoundError("This notification doesn't exist or you don't have access to it.");
  }
  if (notification.readAt) return serializeNotification(notification);

  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: new Date() },
  });
  return serializeNotification(updated);
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { recipientUserId: userId, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}
