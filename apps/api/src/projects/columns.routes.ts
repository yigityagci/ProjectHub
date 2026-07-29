import type { FastifyInstance } from "fastify";
import { createColumnSchema, updateColumnSchema, reorderColumnsSchema } from "@projecthub/shared";
import { ValidationError } from "../core/errors.js";
import {
  requireAuth,
  requireCsrf,
  requireMembership,
  requireProjectAccess,
  requireCategoryAccess,
  requirePermission,
} from "../rbac/guards.js";
import { listColumns, createColumn, updateColumn, reorderColumns, deleteColumn } from "./columns.service.js";
import { emitToCategory } from "../realtime/realtime.js";

/**
 * Columns are category-scoped: each category owns its own board (its own
 * BoardColumns), not a shared project-wide board filtered by category.
 * requireCategoryAccess is inserted immediately after requireProjectAccess
 * on every route here, per the guard chain documented in rbac/guards.ts.
 */
export async function registerColumnRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/columns",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess, requireCategoryAccess] },
    async (req, reply) => {
      const columns = await listColumns(req.ctx.category!.id);
      return reply.send({ columns });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/columns",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("board.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = createColumnSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const column = await createColumn(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        req.ctx.category!.id,
        parsed.data,
      );
      emitToCategory(req.ctx.category!.id, "board.column.changed", { column });
      return reply.code(201).send({ column });
    },
  );

  app.patch(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/columns/:columnId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("board.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = updateColumnSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { columnId } = req.params as { columnId: string };
      const column = await updateColumn(req.ctx.workspace!.id, req.ctx.category!.id, columnId, parsed.data);
      emitToCategory(req.ctx.category!.id, "board.column.changed", { column });
      return reply.send({ column });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/columns/reorder",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("board.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = reorderColumnsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const columns = await reorderColumns(req.ctx.workspace!.id, req.ctx.category!.id, parsed.data.columnIds);
      emitToCategory(req.ctx.category!.id, "board.column.changed", { columns });
      return reply.send({ columns });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/columns/:columnId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("board.manage"),
      ],
    },
    async (req, reply) => {
      const { columnId } = req.params as { columnId: string };
      await deleteColumn(req.ctx.workspace!.id, req.ctx.category!.id, columnId);
      emitToCategory(req.ctx.category!.id, "board.column.changed", { deletedColumnId: columnId });
      return reply.send({ ok: true });
    },
  );
}
