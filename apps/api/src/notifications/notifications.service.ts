import type { NotificationType } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { NotFoundError } from "../core/errors.js";
import { emitToUser } from "../realtime/realtime.js";

export interface CreateNotificationInput {
  workspaceId: string;
  recipientUserId: string;
  type: NotificationType;
  payload?: Record<string, unknown>;
}

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
 */
export async function createNotification(input: CreateNotificationInput) {
  const notification = await prisma.notification.create({
    data: {
      workspaceId: input.workspaceId,
      recipientUserId: input.recipientUserId,
      type: input.type,
      payload: (input.payload ?? {}) as object,
    },
  });

  emitToUser(input.recipientUserId, "notification.created", serializeNotification(notification));

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
