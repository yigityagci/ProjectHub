import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import {
  createCustomFieldSchema,
  updateCustomFieldSchema,
  reorderCustomFieldsSchema,
  setCustomFieldValueSchema,
} from "@projecthub/shared";
import { ValidationError } from "../core/errors.js";
import {
  requireAuth,
  requireCsrf,
  requireMembership,
  requireProjectAccess,
  requireCategoryAccess,
  requirePermission,
} from "../rbac/guards.js";
import {
  listCustomFields,
  createCustomField,
  updateCustomField,
  reorderCustomFields,
  deleteCustomField,
  listTaskCustomFieldValues,
  setTaskCustomFieldValue,
  clearTaskCustomFieldValue,
  toOptionsArray,
} from "./custom-fields.service.js";

interface CustomFieldDefinitionRow {
  id: string;
  projectId: string;
  name: string;
  type: string;
  options: Prisma.JsonValue;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

function serializeField(field: CustomFieldDefinitionRow) {
  return {
    id: field.id,
    projectId: field.projectId,
    name: field.name,
    type: field.type,
    options: toOptionsArray(field.options),
    position: field.position,
    createdAt: field.createdAt,
    updatedAt: field.updatedAt,
  };
}

/**
 * Custom fields on tasks: project-scoped typed field definitions
 * (CustomFieldDefinition, gated by custom_field.manage) plus per-task values
 * (CustomFieldValue, gated by task.edit — a DIFFERENT permission, since
 * setting a value on a task you can already edit is not the same privilege
 * as defining/reordering/deleting the fields available to a whole project).
 *
 * Deliberately one self-contained vertical file (not split into
 * tasks.routes.ts/tasks.service.ts) since it spans two different guard
 * chains: definition routes are project-scoped (no requireCategoryAccess),
 * value routes are task-scoped and MUST carry requireCategoryAccess — tasks
 * are only ever reachable through the category tier (see
 * tasks.service.ts#getTaskOrThrow), so a project-level value route would
 * bypass private-category/CLIENT isolation entirely.
 */
export async function registerCustomFieldRoutes(app: FastifyInstance): Promise<void> {
  const DEFINITION_BASE = "/api/workspaces/:workspaceId/projects/:projectId/custom-fields";
  const VALUE_BASE =
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks/:taskId/custom-fields";

  // --- Definitions (project-scoped) ---------------------------------------

  app.get(
    DEFINITION_BASE,
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const fields = await listCustomFields(req.ctx.project!.id);
      return reply.send({ fields: fields.map(serializeField) });
    },
  );

  app.post(
    DEFINITION_BASE,
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("custom_field.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = createCustomFieldSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const field = await createCustomField(req.ctx.workspace!.id, req.ctx.project!.id, parsed.data);
      return reply.code(201).send({ field: serializeField(field) });
    },
  );

  app.patch(
    `${DEFINITION_BASE}/:fieldId`,
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("custom_field.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = updateCustomFieldSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { fieldId } = req.params as { fieldId: string };
      const field = await updateCustomField(req.ctx.workspace!.id, req.ctx.project!.id, fieldId, parsed.data);
      return reply.send({ field: serializeField(field) });
    },
  );

  app.post(
    `${DEFINITION_BASE}/reorder`,
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("custom_field.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = reorderCustomFieldsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const fields = await reorderCustomFields(req.ctx.workspace!.id, req.ctx.project!.id, parsed.data.fieldIds);
      return reply.send({ fields: fields.map(serializeField) });
    },
  );

  app.delete(
    `${DEFINITION_BASE}/:fieldId`,
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("custom_field.manage"),
      ],
    },
    async (req, reply) => {
      const { fieldId } = req.params as { fieldId: string };
      await deleteCustomField(req.ctx.workspace!.id, req.ctx.project!.id, fieldId);
      return reply.send({ ok: true });
    },
  );

  // --- Values (task-scoped, reached through the category tier) -----------

  app.get(
    VALUE_BASE,
    {
      preHandler: [requireAuth, requireMembership, requireProjectAccess, requireCategoryAccess],
    },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      const values = await listTaskCustomFieldValues(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        req.ctx.category!.id,
        taskId,
      );
      return reply.send({ values });
    },
  );

  app.put(
    `${VALUE_BASE}/:fieldId`,
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("task.edit"),
      ],
    },
    async (req, reply) => {
      const parsed = setCustomFieldValueSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { taskId, fieldId } = req.params as { taskId: string; fieldId: string };
      const value = await setTaskCustomFieldValue(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        req.ctx.category!.id,
        taskId,
        fieldId,
        parsed.data.value,
      );
      return reply.send({ value });
    },
  );

  app.delete(
    `${VALUE_BASE}/:fieldId`,
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("task.edit"),
      ],
    },
    async (req, reply) => {
      const { taskId, fieldId } = req.params as { taskId: string; fieldId: string };
      await clearTaskCustomFieldValue(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        req.ctx.category!.id,
        taskId,
        fieldId,
      );
      return reply.send({ ok: true });
    },
  );
}
