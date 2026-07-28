import type { FastifyInstance } from "fastify";
import type { RoleKey } from "@projecthub/shared";
import { ValidationError, NotFoundError } from "../core/errors.js";
import {
  requireAuth,
  requireCsrf,
  requireMembership,
  requireProjectAccess,
  requirePermission,
} from "../rbac/guards.js";
import {
  listAttachments,
  createAttachment,
  getAttachmentForDownload,
  deleteAttachment,
} from "./attachments.service.js";

const TASK_SCOPED_PREFIX = "/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId";

export async function registerAttachmentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    `${TASK_SCOPED_PREFIX}/attachments`,
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      const attachments = await listAttachments(req.ctx.workspace!.id, req.ctx.project!.id, taskId);
      return reply.send({ attachments });
    },
  );

  // Upload reuses the existing `task.edit` permission, the same as comment
  // creation — see comments.routes.ts for the rationale.
  app.post(
    `${TASK_SCOPED_PREFIX}/attachments`,
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
      const { taskId } = req.params as { taskId: string };
      const file = await req.file();
      if (!file) {
        throw new ValidationError("A file is required.");
      }
      const data = await file.toBuffer();
      const attachment = await createAttachment({
        workspaceId: req.ctx.workspace!.id,
        projectId: req.ctx.project!.id,
        taskId,
        uploaderId: req.ctx.user!.id,
        filename: file.filename,
        contentType: file.mimetype,
        data,
      });
      return reply.code(201).send({ attachment });
    },
  );

  app.get(
    `${TASK_SCOPED_PREFIX}/attachments/:attachmentId/download`,
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const { taskId, attachmentId } = req.params as { taskId: string; attachmentId: string };
      const { attachment, data } = await getAttachmentForDownload(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        taskId,
        attachmentId,
      );
      reply.header("Content-Type", attachment.contentType);
      reply.header(
        "Content-Disposition",
        `attachment; filename="${attachment.filename.replace(/["\r\n]/g, "_")}"`,
      );
      // Never cached/served as a static, publicly-linkable asset — every
      // download re-runs the full auth + membership + project-access chain
      // above on each request.
      reply.header("Cache-Control", "private, no-store");
      return reply.send(data);
    },
  );

  app.delete(
    `${TASK_SCOPED_PREFIX}/attachments/:attachmentId`,
    { preHandler: [requireAuth, requireCsrf, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const { taskId, attachmentId } = req.params as { taskId: string; attachmentId: string };
      if (!attachmentId) {
        throw new NotFoundError("This attachment doesn't exist on this task.");
      }
      const roleKey = req.ctx.membership!.role.key as RoleKey;
      await deleteAttachment(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        taskId,
        attachmentId,
        req.ctx.user!.id,
        roleKey,
      );
      return reply.send({ ok: true });
    },
  );
}
