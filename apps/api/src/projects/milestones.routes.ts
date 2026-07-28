import type { FastifyInstance } from "fastify";
import { createMilestoneSchema, updateMilestoneSchema } from "@projecthub/shared";
import { ValidationError } from "../core/errors.js";
import {
  requireAuth,
  requireCsrf,
  requireMembership,
  requireProjectAccess,
  requirePermission,
} from "../rbac/guards.js";
import { listMilestones, createMilestone, updateMilestone, deleteMilestone } from "./milestones.service.js";

export async function registerMilestoneRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/milestones",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const milestones = await listMilestones(req.ctx.project!.id);
      return reply.send({ milestones });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/milestones",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("milestone.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = createMilestoneSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const milestone = await createMilestone(req.ctx.workspace!.id, req.ctx.project!.id, parsed.data);
      return reply.code(201).send({ milestone });
    },
  );

  app.patch(
    "/api/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("milestone.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = updateMilestoneSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { milestoneId } = req.params as { milestoneId: string };
      const milestone = await updateMilestone(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        milestoneId,
        parsed.data,
      );
      return reply.send({ milestone });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("milestone.manage"),
      ],
    },
    async (req, reply) => {
      const { milestoneId } = req.params as { milestoneId: string };
      await deleteMilestone(req.ctx.workspace!.id, req.ctx.project!.id, milestoneId);
      return reply.send({ ok: true });
    },
  );
}
