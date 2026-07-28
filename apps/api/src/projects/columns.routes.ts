import type { FastifyInstance } from "fastify";
import { createColumnSchema, updateColumnSchema, reorderColumnsSchema } from "@projecthub/shared";
import { ValidationError } from "../core/errors.js";
import {
  requireAuth,
  requireCsrf,
  requireMembership,
  requireProjectAccess,
  requirePermission,
} from "../rbac/guards.js";
import { listColumns, createColumn, updateColumn, reorderColumns, deleteColumn } from "./columns.service.js";
import { emitToProject } from "../realtime/realtime.js";

export async function registerColumnRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/columns",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const columns = await listColumns(req.ctx.project!.id);
      return reply.send({ columns });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/columns",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("board.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = createColumnSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const column = await createColumn(req.ctx.workspace!.id, req.ctx.project!.id, parsed.data);
      emitToProject(req.ctx.project!.id, "board.column.changed", { column });
      return reply.code(201).send({ column });
    },
  );

  app.patch(
    "/api/workspaces/:workspaceId/projects/:projectId/columns/:columnId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("board.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = updateColumnSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { columnId } = req.params as { columnId: string };
      const column = await updateColumn(req.ctx.workspace!.id, req.ctx.project!.id, columnId, parsed.data);
      emitToProject(req.ctx.project!.id, "board.column.changed", { column });
      return reply.send({ column });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/columns/reorder",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("board.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = reorderColumnsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const columns = await reorderColumns(req.ctx.workspace!.id, req.ctx.project!.id, parsed.data.columnIds);
      emitToProject(req.ctx.project!.id, "board.column.changed", { columns });
      return reply.send({ columns });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/columns/:columnId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("board.manage"),
      ],
    },
    async (req, reply) => {
      const { columnId } = req.params as { columnId: string };
      await deleteColumn(req.ctx.workspace!.id, req.ctx.project!.id, columnId);
      emitToProject(req.ctx.project!.id, "board.column.changed", { deletedColumnId: columnId });
      return reply.send({ ok: true });
    },
  );
}
