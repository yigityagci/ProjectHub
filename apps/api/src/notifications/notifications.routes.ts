import type { FastifyInstance } from "fastify";
import { requireAuth, requireCsrf } from "../rbac/guards.js";
import {
  listNotificationsForUser,
  markNotificationRead,
  markAllNotificationsRead,
} from "./notifications.service.js";

/**
 * Notifications are user-scoped, not workspace-scoped in the URL: a single
 * authenticated user may have notifications from many workspaces, and this
 * listing spans all of them (each notification still carries its own
 * `workspaceId`). Every query/mutation below is filtered by
 * `recipientUserId = req.ctx.user.id` so a caller can never read or mark
 * another user's notification — not even to confirm it exists (404, same
 * IDOR-prevention convention as every other resource in this codebase).
 */
export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/notifications", { preHandler: [requireAuth] }, async (req, reply) => {
    const notifications = await listNotificationsForUser(req.ctx.user!.id);
    return reply.send({ notifications });
  });

  app.post(
    "/api/notifications/:id/read",
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const notification = await markNotificationRead(req.ctx.user!.id, id);
      return reply.send({ notification });
    },
  );

  app.post(
    "/api/notifications/read-all",
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const count = await markAllNotificationsRead(req.ctx.user!.id);
      return reply.send({ ok: true, count });
    },
  );
}
