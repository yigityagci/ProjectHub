import type { FastifyInstance } from "fastify";
import { createCategorySchema, updateCategorySchema, addCategoryMemberSchema } from "@projecthub/shared";
import type { RoleKey } from "@projecthub/shared";
import { ValidationError, NotFoundError } from "../core/errors.js";
import {
  requireAuth,
  requireCsrf,
  requireMembership,
  requireProjectAccess,
  requireCategoryAccess,
  requirePermission,
} from "../rbac/guards.js";
import {
  createCategory,
  listCategoriesForUser,
  updateCategory,
  deleteCategory,
  listCategoryMembers,
  addCategoryMember,
  removeCategoryMember,
} from "./categories.service.js";
import { emitToProject, revalidateRoomsForUser } from "../realtime/realtime.js";

function serializeCategory(category: {
  id: string;
  projectId: string;
  name: string;
  visibility: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: category.id,
    projectId: category.projectId,
    name: category.name,
    visibility: category.visibility,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}

/**
 * Categories: the required sub-division inside each Project (Workspace ->
 * Project -> Category -> Task). Listing does its own per-row access
 * filtering (mirrors listProjectsForUser) so it never needs
 * requireCategoryAccess itself — that guard only applies once a specific
 * `:categoryId` is in the URL. Create doesn't need requireCategoryAccess
 * either (there's no category yet); every other route requires it,
 * inserted immediately after requireProjectAccess per the guard chain
 * documented in rbac/guards.ts.
 */
export async function registerCategoryRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/categories",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const roleKey = req.ctx.membership!.role.key as RoleKey;
      const categories = await listCategoriesForUser(req.ctx.project!.id, req.ctx.user!.id, roleKey);
      return reply.send({ categories: categories.map(serializeCategory) });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/categories",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("category.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = createCategorySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const category = await createCategory({
        ...parsed.data,
        workspaceId: req.ctx.workspace!.id,
        projectId: req.ctx.project!.id,
      });
      const serialized = serializeCategory(category);
      // Category picker views (if listening) can refresh their project-wide
      // category list on this project-room event.
      emitToProject(req.ctx.project!.id, "board.column.changed", { categoryCreated: serialized });
      return reply.code(201).send({ category: serialized });
    },
  );

  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId",
    {
      preHandler: [requireAuth, requireMembership, requireProjectAccess, requireCategoryAccess],
    },
    async (req, reply) => {
      return reply.send({ category: serializeCategory(req.ctx.category!) });
    },
  );

  app.patch(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("category.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = updateCategorySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const updated = await updateCategory(req.ctx.project!.id, req.ctx.category!.id, parsed.data);
      const serialized = serializeCategory(updated);
      emitToProject(req.ctx.project!.id, "board.column.changed", { categoryUpdated: serialized });
      return reply.send({ category: serialized });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("category.manage"),
      ],
    },
    async (req, reply) => {
      await deleteCategory(req.ctx.project!.id, req.ctx.category!.id);
      emitToProject(req.ctx.project!.id, "board.column.changed", { categoryDeletedId: req.ctx.category!.id });
      return reply.send({ ok: true });
    },
  );

  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/members",
    {
      preHandler: [requireAuth, requireMembership, requireProjectAccess, requireCategoryAccess],
    },
    async (req, reply) => {
      const members = await listCategoryMembers(req.ctx.category!.id);
      return reply.send({ members });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/members",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("category.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = addCategoryMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      await addCategoryMember(req.ctx.workspace!.id, req.ctx.category!.id, parsed.data.userId);
      emitToProject(req.ctx.project!.id, "category.member.changed", {
        categoryId: req.ctx.category!.id,
        userId: parsed.data.userId,
        action: "added",
      });
      return reply.code(201).send({ ok: true });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/members/:userId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("category.manage"),
      ],
    },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      if (!userId) {
        throw new NotFoundError("This member could not be found in this category.");
      }
      await removeCategoryMember(req.ctx.category!.id, userId);
      emitToProject(req.ctx.project!.id, "category.member.changed", {
        categoryId: req.ctx.category!.id,
        userId,
        action: "removed",
      });
      // A removed category member (or a category made private) may have
      // lost access to this category's real-time room; force an immediate
      // re-check so they stop receiving further events for it, mirroring
      // the "permissions take effect immediately" guarantee used for
      // project membership removal.
      await revalidateRoomsForUser(userId);
      return reply.send({ ok: true });
    },
  );
}
