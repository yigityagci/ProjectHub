import type { FastifyInstance } from "fastify";
import { activityListQuerySchema } from "@projecthub/shared";
import type { RoleKey } from "@projecthub/shared";
import { ValidationError } from "../core/errors.js";
import { requireAuth, requireMembership, requireProjectAccess } from "../rbac/guards.js";
import { listActivityEvents } from "./activity.service.js";

/**
 * Read-only, workspace/project-scoped activity feed. Gated by the same
 * read-access rules as everything else in the project
 * (`requireMembership` + `requireProjectAccess`) — Viewer/Client included,
 * since this is a read-only feed, not a permission-gated action. Every
 * cross-workspace/cross-project access attempt returns 404, exactly like
 * every other resource in this codebase.
 *
 * This project-wide feed spans every category, so it passes the caller's
 * identity through to listActivityEvents so it can exclude any event
 * belonging to a private category the caller can't see (see
 * activity.service.ts#listActivityEvents / categories.service.ts's shared
 * visible-category-id helper).
 */
export async function registerActivityRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/activity",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const parsed = activityListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const roleKey = req.ctx.membership!.role.key as RoleKey;
      const result = await listActivityEvents(
        req.ctx.project!.id,
        { limit: parsed.data.limit, cursor: parsed.data.cursor, categoryId: parsed.data.categoryId },
        { userId: req.ctx.user!.id, roleKey },
      );
      return reply.send(result);
    },
  );
}
