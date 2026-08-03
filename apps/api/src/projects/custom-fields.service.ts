import type { Prisma } from "@prisma/client";
import type {
  CreateCustomFieldInput,
  CustomFieldType,
  UpdateCustomFieldInput,
} from "@projecthub/shared";
import { buildCustomFieldValueSchema, MAX_CUSTOM_FIELDS_PER_PROJECT } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors.js";
import { computeAppendPosition, rebalancePositions } from "./position.js";
import { getTaskOrThrow } from "./tasks.service.js";

const FIELD_NOT_FOUND_MESSAGE = "This custom field doesn't exist in this project.";

const SELECT_TYPES = new Set<CustomFieldType>(["select", "multi_select"]);

/**
 * Prisma returns `Prisma.JsonValue` for the `options` column, which is a wide
 * union (string | number | boolean | JsonObject | JsonArray | null). This
 * normalizer is the ONE place that narrows it back down to the `string[]`
 * shape every option list is actually stored as (enforced by
 * packages/shared's create/update schemas, never by the database) — no
 * response or internal caller should ever see the raw `JsonValue` type.
 */
export function toOptionsArray(raw: Prisma.JsonValue): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

export interface CustomFieldValueDTO {
  taskId: string;
  fieldId: string;
  value: Prisma.JsonValue;
  stale: boolean;
  updatedAt: Date;
}

export async function listCustomFields(projectId: string) {
  return prisma.customFieldDefinition.findMany({
    where: { projectId },
    orderBy: { position: "asc" },
  });
}

export async function createCustomField(
  workspaceId: string,
  projectId: string,
  input: CreateCustomFieldInput,
) {
  const existing = await prisma.customFieldDefinition.findUnique({
    where: { projectId_name: { projectId, name: input.name } },
  });
  if (existing) {
    throw new ConflictError("A custom field with this name already exists in this project.");
  }

  const count = await prisma.customFieldDefinition.count({ where: { projectId } });
  if (count >= MAX_CUSTOM_FIELDS_PER_PROJECT) {
    throw new ConflictError(
      `This project already has the maximum of ${MAX_CUSTOM_FIELDS_PER_PROJECT} custom fields.`,
    );
  }

  const maxPositionField = await prisma.customFieldDefinition.findFirst({
    where: { projectId },
    orderBy: { position: "desc" },
  });

  const options = SELECT_TYPES.has(input.type) ? (input.options ?? []) : [];

  return prisma.customFieldDefinition.create({
    data: {
      workspaceId,
      projectId,
      name: input.name,
      type: input.type,
      options,
      position: computeAppendPosition(maxPositionField?.position ?? null),
    },
  });
}

/**
 * This function must never read, write, or delete `CustomFieldValue` rows —
 * see the stale-value policy documented on the CustomFieldValue model in
 * schema.prisma. Existing value rows are left completely untouched by any
 * definition edit; they become unenforced legacy data, surfaced via `stale`
 * on the value read endpoint, and are only ever re-validated on their next
 * write.
 */
export async function updateCustomField(
  workspaceId: string,
  projectId: string,
  fieldId: string,
  input: UpdateCustomFieldInput,
) {
  const field = await prisma.customFieldDefinition.findFirst({
    where: { id: fieldId, projectId, workspaceId },
  });
  if (!field) {
    throw new NotFoundError(FIELD_NOT_FOUND_MESSAGE);
  }

  if (input.name !== undefined && input.name !== field.name) {
    const clash = await prisma.customFieldDefinition.findUnique({
      where: { projectId_name: { projectId, name: input.name } },
    });
    if (clash) {
      throw new ConflictError("A custom field with this name already exists in this project.");
    }
  }

  // `updateCustomFieldSchema` has no `type` key in scope, so it can only
  // reject an empty/duplicated/too-long `options` array — it cannot know
  // whether `options` is even a valid key for THIS field's type. That check
  // requires the stored `type`, which only the service layer has.
  if (input.options !== undefined && !SELECT_TYPES.has(field.type as CustomFieldType)) {
    throw new ValidationError("options is only valid for select and multi_select fields.");
  }

  return prisma.customFieldDefinition.update({
    where: { id: fieldId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.options !== undefined ? { options: input.options } : {}),
    },
  });
}

export async function reorderCustomFields(workspaceId: string, projectId: string, fieldIds: string[]) {
  const fields = await prisma.customFieldDefinition.findMany({ where: { projectId, workspaceId } });
  const fieldIdSet = new Set(fields.map((f) => f.id));
  // `new Set(fieldIds).size !== fieldIds.length` catches duplicates that a
  // bare length-and-membership check (reorderColumns' original shape) would
  // miss whenever a duplicate happens to compensate for an omitted id.
  const uniqueRequestedIds = new Set(fieldIds);

  if (
    fieldIds.length !== fields.length ||
    uniqueRequestedIds.size !== fieldIds.length ||
    !fieldIds.every((id) => fieldIdSet.has(id))
  ) {
    throw new NotFoundError(
      "The custom field list must include every custom field of this project exactly once.",
    );
  }

  await prisma.$transaction(async (tx) => {
    await rebalancePositions(fieldIds, (id, position) =>
      tx.customFieldDefinition.update({ where: { id }, data: { position } }),
    );
  });

  return listCustomFields(projectId);
}

/**
 * No value-count guard before deleting, unlike deleteColumn's task-count
 * check: the FK cascade deleting orphaned CustomFieldValue rows IS the
 * intended behaviour here (mirrors deleteLabel cascading TaskLabel), not an
 * oversight — a custom field definition is meant to be freely retractable,
 * and its per-task values have no meaning once the definition is gone.
 */
export async function deleteCustomField(workspaceId: string, projectId: string, fieldId: string) {
  const field = await prisma.customFieldDefinition.findFirst({
    where: { id: fieldId, projectId, workspaceId },
  });
  if (!field) {
    throw new NotFoundError(FIELD_NOT_FOUND_MESSAGE);
  }
  await prisma.customFieldDefinition.delete({ where: { id: fieldId } });
}

export async function listTaskCustomFieldValues(
  workspaceId: string,
  projectId: string,
  categoryId: string,
  taskId: string,
): Promise<CustomFieldValueDTO[]> {
  await getTaskOrThrow(workspaceId, categoryId, taskId);

  const [fields, values] = await Promise.all([
    prisma.customFieldDefinition.findMany({ where: { projectId } }),
    prisma.customFieldValue.findMany({ where: { taskId } }),
  ]);
  const fieldById = new Map(fields.map((f) => [f.id, f]));

  return values.map((v) => {
    const field = fieldById.get(v.fieldId);
    // The field's definition was deleted out from under this value (should
    // never happen given the FK cascade, but defensively treated as stale
    // rather than thrown) or belongs to a different project than this task's
    // (also should never happen) — either way, unverifiable, so stale.
    let stale = true;
    if (field) {
      const schema = buildCustomFieldValueSchema({
        type: field.type as CustomFieldType,
        options: toOptionsArray(field.options),
      });
      stale = !schema.safeParse(v.value).success;
    }
    return { taskId: v.taskId, fieldId: v.fieldId, value: v.value, stale, updatedAt: v.updatedAt };
  });
}

export async function setTaskCustomFieldValue(
  workspaceId: string,
  projectId: string,
  categoryId: string,
  taskId: string,
  fieldId: string,
  rawValue: unknown,
): Promise<CustomFieldValueDTO> {
  await getTaskOrThrow(workspaceId, categoryId, taskId);

  // IDOR barrier: the field must belong to THIS project (and workspace),
  // exactly mirroring addLabel's label lookup in tasks.service.ts. A field id
  // from another project must 404, never silently succeed.
  const field = await prisma.customFieldDefinition.findFirst({
    where: { id: fieldId, projectId, workspaceId },
  });
  if (!field) {
    throw new NotFoundError(FIELD_NOT_FOUND_MESSAGE);
  }

  const schema = buildCustomFieldValueSchema({
    type: field.type as CustomFieldType,
    options: toOptionsArray(field.options),
  });
  const parsed = schema.safeParse(rawValue);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid custom field value.");
  }

  try {
    const row = await prisma.customFieldValue.upsert({
      where: { taskId_fieldId: { taskId, fieldId } },
      update: { value: parsed.data as Prisma.InputJsonValue },
      create: { workspaceId, taskId, fieldId, value: parsed.data as Prisma.InputJsonValue },
    });
    return { taskId: row.taskId, fieldId: row.fieldId, value: row.value, stale: false, updatedAt: row.updatedAt };
  } catch (_err) {
    // Defense in depth for the narrow race where the field definition (or
    // task) was deleted between the lookup above and this write.
    throw new NotFoundError(FIELD_NOT_FOUND_MESSAGE);
  }
}

export async function clearTaskCustomFieldValue(
  workspaceId: string,
  projectId: string,
  categoryId: string,
  taskId: string,
  fieldId: string,
): Promise<void> {
  await getTaskOrThrow(workspaceId, categoryId, taskId);
  const existing = await prisma.customFieldValue.findUnique({ where: { taskId_fieldId: { taskId, fieldId } } });
  if (!existing) {
    throw new NotFoundError("This custom field has no value set on this task.");
  }
  await prisma.customFieldValue.delete({ where: { taskId_fieldId: { taskId, fieldId } } });
}
