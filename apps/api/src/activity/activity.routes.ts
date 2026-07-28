import type { FastifyInstance } from "fastify";
import { activityListQuerySchema } from "@projecthub/shared";
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
      const result = await listActivityEvents(req.ctx.project!.id, parsed.data);
      return reply.send(result);
    },
  );
}
