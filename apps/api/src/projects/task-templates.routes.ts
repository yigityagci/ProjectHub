import type { FastifyInstance } from "fastify";
import { createTaskTemplateSchema, updateTaskTemplateSchema } from "@projecthub/shared";
import { ValidationError } from "../core/errors.js";
import {
  requireAuth,
  requireCsrf,
  requireMembership,
  requireProjectAccess,
  requirePermission,
} from "../rbac/guards.js";
import {
  listTaskTemplates,
  createTaskTemplate,
  updateTaskTemplate,
  deleteTaskTemplate,
} from "./task-templates.service.js";

interface TaskTemplateRow {
  id: string;
  projectId: string;
  name: string;
  titleTemplate: string;
  description: string | null;
  priority: string | null;
  defaultLabelIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

function serializeTemplate(template: TaskTemplateRow) {
  return {
    id: template.id,
    projectId: template.projectId,
    name: template.name,
    titleTemplate: template.titleTemplate,
    description: template.description,
    priority: template.priority,
    defaultLabelIds: template.defaultLabelIds,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

/**
 * Task templates: project-scoped canned task blueprints (TaskTemplate,
 * gated by task_template.manage). GET is deliberately ungated by any
 * permission beyond project membership — every project member must be able
 * to read templates to use the create-from-template quick action, mirroring
 * listLabels/listCustomFields's own ungated GET.
 */
export async function registerTaskTemplateRoutes(app: FastifyInstance): Promise<void> {
  const BASE = "/api/workspaces/:workspaceId/projects/:projectId/task-templates";

  app.get(
    BASE,
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const templates = await listTaskTemplates(req.ctx.project!.id);
      return reply.send({ templates: templates.map(serializeTemplate) });
    },
  );

  app.post(
    BASE,
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("task_template.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = createTaskTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const template = await createTaskTemplate(req.ctx.workspace!.id, req.ctx.project!.id, parsed.data);
      return reply.code(201).send({ template: serializeTemplate(template) });
    },
  );

  app.patch(
    `${BASE}/:templateId`,
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("task_template.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = updateTaskTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { templateId } = req.params as { templateId: string };
      const template = await updateTaskTemplate(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        templateId,
        parsed.data,
      );
      return reply.send({ template: serializeTemplate(template) });
    },
  );

  app.delete(
    `${BASE}/:templateId`,
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("task_template.manage"),
      ],
    },
    async (req, reply) => {
      const { templateId } = req.params as { templateId: string };
      await deleteTaskTemplate(req.ctx.workspace!.id, req.ctx.project!.id, templateId);
      return reply.send({ ok: true });
    },
  );
}
