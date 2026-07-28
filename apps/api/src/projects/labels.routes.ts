import type { FastifyInstance } from "fastify";
import { createLabelSchema, updateLabelSchema } from "@projecthub/shared";
import { ValidationError } from "../core/errors.js";
import {
  requireAuth,
  requireCsrf,
  requireMembership,
  requireProjectAccess,
  requirePermission,
} from "../rbac/guards.js";
import { listLabels, createLabel, updateLabel, deleteLabel } from "./labels.service.js";

export async function registerLabelRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/labels",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const labels = await listLabels(req.ctx.project!.id);
      return reply.send({ labels });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/labels",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("label.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = createLabelSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const label = await createLabel(req.ctx.workspace!.id, req.ctx.project!.id, parsed.data);
      return reply.code(201).send({ label });
    },
  );

  app.patch(
    "/api/workspaces/:workspaceId/projects/:projectId/labels/:labelId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("label.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = updateLabelSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { labelId } = req.params as { labelId: string };
      const label = await updateLabel(req.ctx.workspace!.id, req.ctx.project!.id, labelId, parsed.data);
      return reply.send({ label });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/labels/:labelId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("label.manage"),
      ],
    },
    async (req, reply) => {
      const { labelId } = req.params as { labelId: string };
      await deleteLabel(req.ctx.workspace!.id, req.ctx.project!.id, labelId);
      return reply.send({ ok: true });
    },
  );
}
