import { z } from "zod";
import { taskPrioritySchema, taskTitleSchema } from "./task.js";

export const MAX_TASK_TEMPLATE_DEFAULT_LABELS = 20;

// Mirrors labelNameSchema/customFieldNameSchema.
export const taskTemplateNameSchema = z
  .string({ required_error: "Template name is required." })
  .trim()
  .min(1, "Template name is required.")
  .max(50, "Template name must be between 1 and 50 characters.");

// Reuses taskTitleSchema's exact bounds — a template's titleTemplate is
// copied byte-for-byte into a new task's title, so it must satisfy the same
// constraints createTaskSchema's own `title` does.
export const titleTemplateSchema = taskTitleSchema;

export const defaultLabelIdsSchema = z
  .array(z.string().min(1))
  .max(
    MAX_TASK_TEMPLATE_DEFAULT_LABELS,
    `At most ${MAX_TASK_TEMPLATE_DEFAULT_LABELS} labels are allowed.`,
  )
  .refine((ids) => new Set(ids).size === ids.length, "defaultLabelIds must not contain duplicates.");

export const createTaskTemplateSchema = z
  .object({
    name: taskTemplateNameSchema,
    titleTemplate: titleTemplateSchema,
    description: z.string().trim().max(20000).optional(),
    priority: taskPrioritySchema.optional(),
    defaultLabelIds: defaultLabelIdsSchema.optional(),
  })
  .strict();
export type CreateTaskTemplateInput = z.infer<typeof createTaskTemplateSchema>;

// PATCH semantics: an omitted key is untouched. `description`/`priority` are
// additionally nullable so they can be explicitly cleared (mirrors
// updateProjectSchema's nullable `description`). `defaultLabelIds` is a
// whole-list replace, no separate add/remove-one endpoint (mirrors
// reorderCustomFields taking the whole ordered list).
export const updateTaskTemplateSchema = z
  .object({
    name: taskTemplateNameSchema.optional(),
    titleTemplate: titleTemplateSchema.optional(),
    description: z.string().trim().max(20000).nullable().optional(),
    priority: taskPrioritySchema.nullable().optional(),
    defaultLabelIds: defaultLabelIdsSchema.optional(),
  })
  .strict();
export type UpdateTaskTemplateInput = z.infer<typeof updateTaskTemplateSchema>;
