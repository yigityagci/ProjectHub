import type { FastifyInstance } from "fastify";
import type { RoleKey } from "@projecthub/shared";
import { requireAuth, requireMembership, requireProjectAccess, requirePermission } from "../rbac/guards.js";
import { getProjectAnalytics } from "./analytics.service.js";

/**
 * Analytics gated by the existing `analytics.view` permission (already
 * granted to OWNER/ADMIN/PROJECT_MANAGER — see packages/shared/src/roles.ts)
 * on top of the usual `requireMembership` + `requireProjectAccess` chain, so
 * cross-workspace/cross-project access still returns 404 before the
 * permission check ever runs.
 */
export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/analytics",
    {
      preHandler: [
        requireAuth,
        requireMembership,
        requireProjectAccess,
        requirePermission("analytics.view"),
      ],
    },
    async (req, reply) => {
      const roleKey = req.ctx.membership!.role.key as RoleKey;
      const analytics = await getProjectAnalytics(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        {
          startDate: req.ctx.project!.startDate,
          targetDate: req.ctx.project!.targetDate,
          createdAt: req.ctx.project!.createdAt,
        },
        { userId: req.ctx.user!.id, roleKey },
      );
      return reply.send({ analytics });
    },
  );
}
