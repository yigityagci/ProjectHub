import type { FastifyInstance } from "fastify";
import { createWorkspaceSchema, updateWorkspaceSchema } from "@projecthub/shared";
import { ValidationError, NotFoundError } from "../core/errors.js";
import { requireAuth, requireMembership, requirePermission, requireCsrf } from "../rbac/guards.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import {
  createWorkspace,
  listWorkspacesForUser,
  updateWorkspace,
} from "./workspaces.service.js";

const WORKSPACE_NOT_FOUND_MESSAGE = "This workspace doesn't exist or you don't have access to it.";

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/workspaces",
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      // Only name/slug are accepted from the client (Zod .strict() rejects
      // anything else, e.g. a client-supplied ownerId).
      const parsed = createWorkspaceSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      const workspace = await createWorkspace({
        name: parsed.data.name,
        slug: parsed.data.slug,
        ownerId: req.ctx.user!.id,
      });

      return reply.code(201).send({ workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug } });
    },
  );

  app.get("/api/workspaces", { preHandler: [requireAuth] }, async (req, reply) => {
    const workspaces = await listWorkspacesForUser(req.ctx.user!.id);
    return reply.send({ workspaces });
  });

  app.get(
    "/api/workspaces/:workspaceId",
    { preHandler: [requireAuth, requireMembership] },
    async (req, reply) => {
      const workspace = req.ctx.workspace!;
      return reply.send({
        workspace: {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          settings: workspace.settings,
          createdAt: workspace.createdAt,
        },
        role: req.ctx.membership!.role.key,
      });
    },
  );

  app.patch(
    "/api/workspaces/:workspaceId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requirePermission("workspace.settings.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = updateWorkspaceSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      if (!req.ctx.workspace) {
        throw new NotFoundError(WORKSPACE_NOT_FOUND_MESSAGE);
      }

      const updated = await updateWorkspace(req.ctx.workspace.id, parsed.data);

      await recordAuditEvent({
        workspaceId: req.ctx.workspace.id,
        actorId: req.ctx.user!.id,
        action: "workspace.settings.updated",
        targetType: "Workspace",
        targetId: req.ctx.workspace.id,
        metadata: { fieldsChanged: Object.keys(parsed.data) },
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({
        workspace: {
          id: updated.id,
          name: updated.name,
          slug: updated.slug,
          settings: updated.settings,
        },
      });
    },
  );
}
