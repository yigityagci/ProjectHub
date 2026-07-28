import type { FastifyInstance } from "fastify";
import { createCommentSchema } from "@projecthub/shared";
import type { RoleKey } from "@projecthub/shared";
import { ValidationError } from "../core/errors.js";
import {
  requireAuth,
  requireCsrf,
  requireMembership,
  requireProjectAccess,
  requirePermission,
} from "../rbac/guards.js";
import { listComments, createComment, deleteComment } from "./comments.service.js";

const TASK_SCOPED_PREFIX = "/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId";

export async function registerCommentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    `${TASK_SCOPED_PREFIX}/comments`,
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      const comments = await listComments(req.ctx.workspace!.id, req.ctx.project!.id, taskId);
      return reply.send({ comments });
    },
  );

  // Comment creation reuses the existing `task.edit` permission rather than
  // introducing a new `comment.create` permission: the same roles that can
  // edit a task's content (OWNER/ADMIN/PROJECT_MANAGER/MEMBER) can comment
  // on it, and VIEWER/CLIENT remain strictly read-only, matching Phase 2's
  // existing semantics exactly.
  app.post(
    `${TASK_SCOPED_PREFIX}/comments`,
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("task.edit"),
      ],
    },
    async (req, reply) => {
      const parsed = createCommentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { taskId } = req.params as { taskId: string };
      const comment = await createComment({
        workspaceId: req.ctx.workspace!.id,
        projectId: req.ctx.project!.id,
        taskId,
        authorId: req.ctx.user!.id,
        authorDisplayName: req.ctx.user!.displayName,
        input: parsed.data,
      });
      return reply.code(201).send({ comment });
    },
  );

  // Deletion is an ownership-or-elevated-role rule (author, or
  // Admin/Owner), enforced in the service layer — not a permission gate.
  app.delete(
    `${TASK_SCOPED_PREFIX}/comments/:commentId`,
    { preHandler: [requireAuth, requireCsrf, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const { taskId, commentId } = req.params as { taskId: string; commentId: string };
      const roleKey = req.ctx.membership!.role.key as RoleKey;
      await deleteComment(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        taskId,
        commentId,
        req.ctx.user!.id,
        roleKey,
      );
      return reply.send({ ok: true });
    },
  );
}
