import { z } from "zod";
import { recurrenceRuleInputSchema } from "./recurrence.js";

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const taskTitleSchema = z
  .string({ required_error: "Task title is required." })
  .trim()
  .min(1, "Task title is required.")
  .max(255, "Task title must be between 1 and 255 characters.");

export const taskPrioritySchema = z.enum(TASK_PRIORITIES, {
  errorMap: () => ({ message: "Invalid task priority." }),
});

/**
 * Strict allowlist for task creation. `creatorId`/`projectId`/`workspaceId`
 * are always derived server-side and never accepted from the client.
 */
export const createTaskSchema = z
  .object({
    title: taskTitleSchema,
    description: z.string().trim().max(20000).optional(),
    columnId: z.string().min(1).optional(),
    priority: taskPrioritySchema.optional(),
    parentTaskId: z.string().min(1).nullable().optional(),
    milestoneId: z.string().min(1).nullable().optional(),
    startDate: z.coerce.date().nullable().optional(),
    dueDate: z.coerce.date().nullable().optional(),
  })
  .strict();
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/**
 * `version` is REQUIRED on every update, but is only ever used as an
 * optimistic-concurrency WHERE precondition server-side — it is never
 * written back to the row verbatim (the row's stored version is always
 * bumped via `{ increment: 1 }`).
 *
 * `completed` is a boolean *intent*, mirroring that same safety posture: the
 * client can only ever ask to mark a task done/not-done, never supply a raw
 * `completedAt` timestamp directly — the server alone decides the actual
 * stored value (`new Date()` or `null`). This is a second, independent way
 * to set the same `Task.completedAt` field `moveTask` already sets
 * automatically on a done-category column transition; setting it here never
 * changes the task's `columnId`.
 */
export const updateTaskSchema = z
  .object({
    version: z.number().int().nonnegative({ message: "version is required." }),
    title: taskTitleSchema.optional(),
    description: z.string().trim().max(20000).nullable().optional(),
    priority: taskPrioritySchema.optional(),
    parentTaskId: z.string().min(1).nullable().optional(),
    milestoneId: z.string().min(1).nullable().optional(),
    startDate: z.coerce.date().nullable().optional(),
    dueDate: z.coerce.date().nullable().optional(),
    completed: z.boolean().optional(),
    // Recurrence is only ever set on an already-existing task (never at
    // creation time — see createTaskSchema's deliberate omission of this
    // field). This is the ONLY way a client can touch recurrence:
    // `nextRunAt`/`recurrenceCount`/`recurrenceTemplateId` never appear in
    // any zod schema, which makes them automatically-422 on any
    // client-supplied value, since this object is `.strict()`.
    recurrenceRule: recurrenceRuleInputSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.parentTaskId != null && value.recurrenceRule != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A subtask can't be a recurring task.",
        path: ["recurrenceRule"],
      });
    }
  });
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const moveTaskSchema = z
  .object({
    version: z.number().int().nonnegative({ message: "version is required." }),
    columnId: z.string().min(1, "columnId is required."),
    beforeTaskId: z.string().min(1).nullable().optional(),
    afterTaskId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type MoveTaskInput = z.infer<typeof moveTaskSchema>;

export const addAssigneeSchema = z
  .object({
    userId: z.string().min(1, "userId is required."),
  })
  .strict();
export type AddAssigneeInput = z.infer<typeof addAssigneeSchema>;

export const createDependencySchema = z
  .object({
    blockingTaskId: z.string().min(1, "blockingTaskId is required."),
  })
  .strict();
export type CreateDependencyInput = z.infer<typeof createDependencySchema>;

/**
 * Phase 7 search/filter query params for `GET .../tasks`. Deliberately a
 * plain `WHERE` builder (substring `contains` match, no full-text index) —
 * this always composes with, never replaces, the `workspaceId`/`projectId`
 * scoping already enforced by `requireMembership`/`requireProjectAccess`;
 * none of these fields can be used to reach another project's/workspace's
 * tasks.
 */
const queryBooleanSchema = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

export const taskListQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(255).optional(),
    columnId: z.string().min(1).optional(),
    priority: taskPrioritySchema.optional(),
    assigneeId: z.string().min(1).optional(),
    labelId: z.string().min(1).optional(),
    overdue: queryBooleanSchema.optional(),
    parentTaskId: z.string().min(1).optional(),
    hasSubtasks: queryBooleanSchema.optional(),
  })
  .strict();
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/**
 * Bulk task actions (`POST .../tasks/bulk`). Deliberately 1:1 with the
 * existing single-task routes rather than collapsed into one generic
 * "update" shape — each variant is `.strict()`, so e.g. `beforeTaskId` on
 * `move`, or `versions` on `delete`, is a 422. Comment-adding is explicitly
 * excluded from bulk actions in v1.
 */
export const BULK_TASK_ACTIONS = [
  "move",
  "assign",
  "unassign",
  "addLabel",
  "removeLabel",
  "setPriority",
  "delete",
] as const;
export type BulkTaskAction = (typeof BULK_TASK_ACTIONS)[number];

/** Per-task result error codes. NOT_IN_CATEGORY deliberately also covers
 * "no such task at all" — the server must not distinguish those two (same
 * rationale as getTaskOrThrow's single TASK_NOT_FOUND_MESSAGE). */
export const BULK_TASK_ERROR_CODES = ["NOT_IN_CATEGORY", "VERSION_CONFLICT"] as const;
export type BulkTaskErrorCode = (typeof BULK_TASK_ERROR_CODES)[number];

export const BULK_TASK_MAX_IDS = 100;

const bulkTaskIdsSchema = z
  .array(z.string().min(1))
  .min(1, "Select at least one task.")
  .max(BULK_TASK_MAX_IDS, `You can act on at most ${BULK_TASK_MAX_IDS} tasks at a time.`);

/** Optimistic-concurrency preconditions keyed by task id. Present ONLY on the
 * actions whose single-task equivalents require `version`
 * (updateTaskSchema / moveTaskSchema) — never optional, so bulk can never be
 * used as a version-check bypass. */
const bulkVersionsSchema = z.record(z.string().min(1), z.number().int().nonnegative());

export const bulkTaskActionSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("move"),
        taskIds: bulkTaskIdsSchema,
        versions: bulkVersionsSchema,
        columnId: z.string().min(1, "columnId is required."),
      })
      .strict(),
    z
      .object({
        action: z.literal("setPriority"),
        taskIds: bulkTaskIdsSchema,
        versions: bulkVersionsSchema,
        priority: taskPrioritySchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("assign"),
        taskIds: bulkTaskIdsSchema,
        userId: z.string().min(1, "userId is required."),
      })
      .strict(),
    z
      .object({
        action: z.literal("unassign"),
        taskIds: bulkTaskIdsSchema,
        userId: z.string().min(1, "userId is required."),
      })
      .strict(),
    z
      .object({
        action: z.literal("addLabel"),
        taskIds: bulkTaskIdsSchema,
        labelId: z.string().min(1, "labelId is required."),
      })
      .strict(),
    z
      .object({
        action: z.literal("removeLabel"),
        taskIds: bulkTaskIdsSchema,
        labelId: z.string().min(1, "labelId is required."),
      })
      .strict(),
    z
      .object({
        action: z.literal("delete"),
        taskIds: bulkTaskIdsSchema,
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (!("versions" in value)) return;
    const unique = new Set(value.taskIds);
    for (const id of unique) {
      if (value.versions[id] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A version is required for every selected task.",
        });
        return;
      }
    }
    for (const id of Object.keys(value.versions)) {
      if (!unique.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "versions contains a task that was not selected.",
        });
        return;
      }
    }
  });
export type BulkTaskActionInput = z.infer<typeof bulkTaskActionSchema>;
