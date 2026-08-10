import { Prisma } from "@prisma/client";
import type { CreateTaskInput, TaskListQuery, UpdateTaskInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { computeAppendPosition, computeInsertPosition } from "./position.js";
import { createActivityEvent, broadcastActivityEvent, type ActingAgent } from "../activity/activity.service.js";

export const DONE_CATEGORY = "done";

export const TASK_NOT_FOUND_MESSAGE = "This task doesn't exist in this category.";

/**
 * Builds the task search/filter `WHERE` clause on top of the mandatory
 * `categoryId` scope (itself already derived from `req.ctx.category`, never
 * from client input) — every filter here only ever narrows this same
 * category's tasks, it can never be used to reach another category's,
 * project's, or workspace's rows (a task from category A can never be
 * reached via category B's URL, even within the same project). Substring
 * match (`contains`), not a full-text index — a deliberate v1 scaffolding
 * choice, adequate for per-category task counts.
 */
function buildTaskWhere(categoryId: string, filters: TaskListQuery = {}): Prisma.TaskWhereInput {
  const where: Prisma.TaskWhereInput = { categoryId };

  if (filters.q) {
    where.OR = [
      { title: { contains: filters.q, mode: "insensitive" } },
      { description: { contains: filters.q, mode: "insensitive" } },
    ];
  }
  if (filters.columnId) where.columnId = filters.columnId;
  if (filters.priority) where.priority = filters.priority;
  if (filters.parentTaskId) where.parentTaskId = filters.parentTaskId;
  if (filters.assigneeId) where.assignees = { some: { userId: filters.assigneeId } };
  if (filters.labelId) where.labels = { some: { labelId: filters.labelId } };
  if (filters.overdue) {
    where.dueDate = { lt: new Date() };
    where.completedAt = null;
  }
  if (filters.hasSubtasks !== undefined) {
    where.subtasks = filters.hasSubtasks ? { some: {} } : { none: {} };
  }

  return where;
}

export async function listTasks(categoryId: string, filters: TaskListQuery = {}) {
  return prisma.task.findMany({
    where: buildTaskWhere(categoryId, filters),
    include: {
      assignees: { include: { user: true } },
      labels: { include: { label: true } },
      recurrenceTemplate: { select: { id: true, title: true } },
    },
    orderBy: [{ columnId: "asc" }, { position: "asc" }],
  });
}

export async function getTaskOrThrow(workspaceId: string, categoryId: string, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId, categoryId },
    include: {
      assignees: { include: { user: true } },
      labels: { include: { label: true } },
      recurrenceTemplate: { select: { id: true, title: true } },
    },
  });
  if (!task) {
    throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);
  }
  return task;
}

/**
 * Enforces the one-level subtask nesting rule when `parentTaskId` is being
 * set on `childTaskId`:
 *  - parentTaskId !== childTaskId
 *  - the parent must exist within the same workspace/category
 *  - the parent must not itself be a subtask (parent.parentTaskId === null)
 *  - the child must not already be a parent of other tasks
 */
async function validateSubtaskNesting(
  workspaceId: string,
  categoryId: string,
  childTaskId: string,
  parentTaskId: string,
): Promise<void> {
  if (parentTaskId === childTaskId) {
    throw new ValidationError("A task cannot be its own subtask.");
  }

  const parent = await prisma.task.findFirst({
    where: { id: parentTaskId, workspaceId, categoryId },
  });
  if (!parent) {
    throw new ValidationError("The parent task must belong to the same category.");
  }
  if (parent.parentTaskId !== null) {
    throw new ValidationError("Subtasks can only be nested one level deep: a subtask cannot itself have subtasks.");
  }

  const childHasSubtasks = await prisma.task.count({ where: { parentTaskId: childTaskId } });
  if (childHasSubtasks > 0) {
    throw new ValidationError(
      "This task already has its own subtasks, so it cannot be nested under another task.",
    );
  }
}

/**
 * Enforces "only a non-subtask, non-instance task can become a recurrence
 * template" (a template can't itself be a spawned instance — no chains —
 * and can't itself be a subtask, mirroring the one-level-nesting spirit of
 * validateSubtaskNesting above, but this is a genuinely separate rule).
 */
function assertCanBeRecurrenceTemplate(
  current: { recurrenceTemplateId: string | null },
  effectiveParentTaskId: string | null,
): void {
  if (effectiveParentTaskId !== null) {
    throw new ValidationError("A subtask can't be made recurring.");
  }
  if (current.recurrenceTemplateId !== null) {
    throw new ValidationError("A task created by a recurring task can't itself be recurring.");
  }
}

async function resolveDefaultColumnId(categoryId: string): Promise<string> {
  const column = await prisma.boardColumn.findFirst({
    where: { categoryId },
    orderBy: { position: "asc" },
  });
  if (!column) {
    throw new ValidationError("This category has no board columns to add a task to.");
  }
  return column.id;
}

export interface CreateTaskParams {
  workspaceId: string;
  projectId: string;
  categoryId: string;
  creatorId: string;
  creatorDisplayName: string;
  input: CreateTaskInput;
  /** Server-derived only — set exclusively by the recurrence scheduler handler (recurrence.service.ts). Never reachable from a request body. */
  recurrenceTemplateId?: string | null;
  /** Present only when this task was created via the MCP create_task tool. See activity.service.ts#ActingAgent. */
  via?: ActingAgent;
}

export async function createTask(params: CreateTaskParams) {
  const { workspaceId, projectId, categoryId, creatorId, creatorDisplayName, input } = params;

  let columnId = input.columnId;
  if (columnId) {
    const column = await prisma.boardColumn.findFirst({ where: { id: columnId, categoryId, workspaceId } });
    if (!column) {
      throw new ValidationError("This column doesn't belong to this category.");
    }
  } else {
    columnId = await resolveDefaultColumnId(categoryId);
  }

  if (input.milestoneId) {
    const milestone = await prisma.milestone.findFirst({
      where: { id: input.milestoneId, projectId, workspaceId },
    });
    if (!milestone) {
      throw new ValidationError("This milestone doesn't belong to this project.");
    }
  }

  let parentTaskId: string | null = null;
  if (input.parentTaskId) {
    const parent = await prisma.task.findFirst({
      where: { id: input.parentTaskId, workspaceId, categoryId },
    });
    if (!parent) {
      throw new ValidationError("The parent task must belong to the same category.");
    }
    if (parent.parentTaskId !== null) {
      throw new ValidationError(
        "Subtasks can only be nested one level deep: a subtask cannot itself have subtasks.",
      );
    }
    parentTaskId = parent.id;
  }

  const maxPositionTask = await prisma.task.findFirst({
    where: { categoryId, columnId },
    orderBy: { position: "desc" },
  });

  // Task creation and the resulting activity-event row are created in the
  // same transaction, so a feed entry can never exist without its
  // underlying task (or vice versa). The event is only broadcast after the
  // transaction has actually committed (see broadcastActivityEvent below).
  const { task, activityEvent } = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        workspaceId,
        projectId,
        categoryId,
        columnId,
        parentTaskId,
        recurrenceTemplateId: params.recurrenceTemplateId ?? null,
        milestoneId: input.milestoneId ?? null,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? "medium",
        position: computeAppendPosition(maxPositionTask?.position ?? null),
        creatorId,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
      },
      include: {
        assignees: { include: { user: true } },
        labels: { include: { label: true } },
        recurrenceTemplate: { select: { id: true, title: true } },
      },
    });

    const event = await createActivityEvent(tx, {
      workspaceId,
      projectId,
      categoryId,
      actorId: creatorId,
      type: "task_created",
      payload: { taskId: created.id, taskTitle: created.title, actorDisplayName: creatorDisplayName },
      via: params.via,
    });

    return { task: created, activityEvent: event };
  });

  broadcastActivityEvent(activityEvent);
  return task;
}

export type UpdateTaskResult =
  | { conflict: false; task: NonNullable<Awaited<ReturnType<typeof getTaskOrThrow>>> }
  | { conflict: true; currentTask: NonNullable<Awaited<ReturnType<typeof getTaskOrThrow>>> };

export async function updateTask(
  workspaceId: string,
  projectId: string,
  categoryId: string,
  taskId: string,
  input: UpdateTaskInput,
): Promise<UpdateTaskResult> {
  // Validate referential fields before attempting the guarded write so a
  // 422 doesn't get masked by a spurious 409.
  if (input.milestoneId !== undefined && input.milestoneId !== null) {
    const milestone = await prisma.milestone.findFirst({
      where: { id: input.milestoneId, projectId, workspaceId },
    });
    if (!milestone) {
      throw new ValidationError("This milestone doesn't belong to this project.");
    }
  }
  if (input.parentTaskId !== undefined && input.parentTaskId !== null) {
    await validateSubtaskNesting(workspaceId, categoryId, taskId, input.parentTaskId);
  }

  // A recurrence-touching PATCH (setting OR clearing recurrenceRule) or one
  // that sets a parentTaskId needs the row's CURRENT
  // parentTaskId/recurrenceTemplateId/recurrenceRule to enforce the
  // recurring<->subtask exclusion rules below, before the guarded
  // updateMany — so a 422 here is never masked by a spurious 409.
  let currentForRecurrence: { parentTaskId: string | null; recurrenceTemplateId: string | null; recurrenceRule: unknown } | null =
    null;
  if (input.recurrenceRule !== undefined || input.parentTaskId != null) {
    currentForRecurrence = await prisma.task.findFirst({
      where: { id: taskId, workspaceId, categoryId },
      select: { parentTaskId: true, recurrenceTemplateId: true, recurrenceRule: true },
    });
    if (!currentForRecurrence) {
      throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);
    }
  }

  if (input.recurrenceRule !== undefined && input.recurrenceRule !== null) {
    const effectiveParentTaskId = input.parentTaskId !== undefined ? input.parentTaskId : currentForRecurrence!.parentTaskId;
    assertCanBeRecurrenceTemplate(currentForRecurrence!, effectiveParentTaskId);
  }

  if (
    input.parentTaskId != null &&
    currentForRecurrence!.recurrenceRule != null &&
    input.recurrenceRule === undefined
  ) {
    throw new ValidationError("A recurring task can't be made a subtask. Stop the recurrence first.");
  }

  const { version, ...rest } = input;
  const data: Record<string, unknown> = {};
  if (rest.title !== undefined) data.title = rest.title;
  if (rest.description !== undefined) data.description = rest.description;
  if (rest.priority !== undefined) data.priority = rest.priority;
  if (rest.parentTaskId !== undefined) data.parentTaskId = rest.parentTaskId;
  if (rest.milestoneId !== undefined) data.milestoneId = rest.milestoneId;
  if (rest.startDate !== undefined) data.startDate = rest.startDate;
  if (rest.dueDate !== undefined) {
    data.dueDate = rest.dueDate;
    data.dueReminderSentAt = null;
  }
  // Explicit checkbox completion — independent of `moveTask`'s automatic
  // done-category completion below: this never touches `columnId`, so a
  // checked-off task stays in whatever column it was already in and simply
  // disappears into that same column's completed/"history" view (derived
  // client-side from `completedAt`, not from a column category). The client
  // only ever expresses true/false intent; the server alone decides the
  // stored timestamp.
  if (rest.completed !== undefined) data.completedAt = rest.completed ? new Date() : null;
  // Any write of a non-null rule (brand new or edited) resets nextRunAt to
  // the rule's own startAt and recurrenceCount to 0 — there is no "adjust in
  // place" concept in v1. Clearing (null) resets the same trio to their
  // not-recurring defaults.
  if (rest.recurrenceRule !== undefined) {
    if (rest.recurrenceRule === null) {
      data.recurrenceRule = Prisma.DbNull;
      data.nextRunAt = null;
      data.recurrenceCount = 0;
    } else {
      data.recurrenceRule = rest.recurrenceRule as Prisma.InputJsonValue;
      data.nextRunAt = new Date(rest.recurrenceRule.startAt);
      data.recurrenceCount = 0;
    }
  }

  const result = await prisma.task.updateMany({
    where: { id: taskId, workspaceId, categoryId, version },
    data: { ...data, version: { increment: 1 } },
  });

  if (result.count === 0) {
    const current = await prisma.task.findFirst({
      where: { id: taskId, workspaceId, categoryId },
      include: {
        assignees: { include: { user: true } },
        labels: { include: { label: true } },
        recurrenceTemplate: { select: { id: true, title: true } },
      },
    });
    if (!current) {
      throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);
    }
    return { conflict: true, currentTask: current };
  }

  const updated = await getTaskOrThrow(workspaceId, categoryId, taskId);
  return { conflict: false, task: updated };
}

export interface MoveTaskInputResolved {
  version: number;
  columnId: string;
  beforeTaskId?: string | null;
  afterTaskId?: string | null;
}

export interface TaskMoveActor {
  id: string;
  displayName: string;
  /** Present only when this move was performed via the MCP move_task tool. See activity.service.ts#ActingAgent. */
  via?: ActingAgent;
}

export async function moveTask(
  workspaceId: string,
  projectId: string,
  categoryId: string,
  taskId: string,
  input: MoveTaskInputResolved,
  actor: TaskMoveActor,
): Promise<UpdateTaskResult> {
  const currentTask = await prisma.task.findFirst({
    where: { id: taskId, workspaceId, categoryId },
    include: { column: true },
  });
  if (!currentTask) {
    throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);
  }

  const targetColumn = await prisma.boardColumn.findFirst({
    where: { id: input.columnId, categoryId, workspaceId },
  });
  if (!targetColumn) {
    throw new ValidationError("This column doesn't belong to this category.");
  }

  let prevPosition: number | null = null;
  let nextPosition: number | null = null;

  if (input.beforeTaskId) {
    const before = await prisma.task.findFirst({
      where: { id: input.beforeTaskId, categoryId, workspaceId, columnId: input.columnId },
    });
    if (!before) {
      throw new ValidationError("beforeTaskId must be an existing task in the target column.");
    }
    prevPosition = before.position;
  }
  if (input.afterTaskId) {
    const after = await prisma.task.findFirst({
      where: { id: input.afterTaskId, categoryId, workspaceId, columnId: input.columnId },
    });
    if (!after) {
      throw new ValidationError("afterTaskId must be an existing task in the target column.");
    }
    nextPosition = after.position;
  }

  if (prevPosition === null && nextPosition === null) {
    const maxPositionTask = await prisma.task.findFirst({
      where: { categoryId, columnId: input.columnId, id: { not: taskId } },
      orderBy: { position: "desc" },
    });
    prevPosition = maxPositionTask?.position ?? null;
  }

  let { position, needsRebalance } = computeInsertPosition(prevPosition, nextPosition);

  if (needsRebalance) {
    const siblings = await prisma.task.findMany({
      where: { categoryId, columnId: input.columnId, id: { not: taskId } },
      orderBy: { position: "asc" },
    });
    await prisma.$transaction(
      siblings.map((sibling, index) =>
        prisma.task.update({ where: { id: sibling.id }, data: { position: index + 1 } }),
      ),
    );
    // Recompute the insertion position against the freshly rebalanced,
    // integer-spaced neighbor positions (now guaranteed to have a safe gap).
    const beforeIndex = input.beforeTaskId ? siblings.findIndex((s) => s.id === input.beforeTaskId) : -1;
    const afterIndex = input.afterTaskId ? siblings.findIndex((s) => s.id === input.afterTaskId) : -1;
    const rebalancedPrev = beforeIndex >= 0 ? beforeIndex + 1 : null;
    const rebalancedNext = afterIndex >= 0 ? afterIndex + 1 : null;
    ({ position } = computeInsertPosition(rebalancedPrev, rebalancedNext));
  }

  // Phase 6: `completedAt` is set the moment a task's column transitions
  // into a `done`-category column, and cleared if it's moved back out —
  // this is the single source of truth the analytics/health-status engine
  // relies on for completion timestamps.
  let completedAtUpdate: Date | null | undefined;
  if (targetColumn.category === DONE_CATEGORY && currentTask.column.category !== DONE_CATEGORY) {
    completedAtUpdate = new Date();
  } else if (targetColumn.category !== DONE_CATEGORY && currentTask.column.category === DONE_CATEGORY) {
    completedAtUpdate = null;
  }

  const result = await prisma.task.updateMany({
    where: { id: taskId, workspaceId, categoryId, version: input.version },
    data: {
      columnId: input.columnId,
      position,
      version: { increment: 1 },
      ...(completedAtUpdate !== undefined ? { completedAt: completedAtUpdate } : {}),
    },
  });

  if (result.count === 0) {
    const current = await prisma.task.findFirst({
      where: { id: taskId, workspaceId, categoryId },
      include: {
        assignees: { include: { user: true } },
        labels: { include: { label: true } },
        recurrenceTemplate: { select: { id: true, title: true } },
      },
    });
    if (!current) {
      throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);
    }
    return { conflict: true, currentTask: current };
  }

  if (currentTask.columnId !== input.columnId) {
    const activityEvent = await createActivityEvent(prisma, {
      workspaceId,
      projectId,
      categoryId,
      actorId: actor.id,
      type: "task_moved",
      payload: {
        taskId,
        taskTitle: currentTask.title,
        fromColumnId: currentTask.columnId,
        fromColumnName: currentTask.column.name,
        toColumnId: targetColumn.id,
        toColumnName: targetColumn.name,
        actorDisplayName: actor.displayName,
      },
      via: actor.via,
    });
    broadcastActivityEvent(activityEvent);
  }

  const updated = await getTaskOrThrow(workspaceId, categoryId, taskId);
  return { conflict: false, task: updated };
}

export async function deleteTask(workspaceId: string, categoryId: string, taskId: string) {
  await getTaskOrThrow(workspaceId, categoryId, taskId);
  await prisma.task.delete({ where: { id: taskId } });
}

export async function addAssignee(
  workspaceId: string,
  projectId: string,
  categoryId: string,
  taskId: string,
  userId: string,
) {
  await getTaskOrThrow(workspaceId, categoryId, taskId);

  const workspaceMembership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!workspaceMembership || workspaceMembership.status !== "active") {
    throw new ValidationError("This user is not an active member of this workspace.");
  }

  return prisma.taskAssignee.upsert({
    where: { taskId_userId: { taskId, userId } },
    update: {},
    create: { workspaceId, taskId, userId },
  });
}

export async function removeAssignee(workspaceId: string, categoryId: string, taskId: string, userId: string) {
  await getTaskOrThrow(workspaceId, categoryId, taskId);
  const existing = await prisma.taskAssignee.findUnique({ where: { taskId_userId: { taskId, userId } } });
  if (!existing) {
    throw new NotFoundError("This user is not assigned to this task.");
  }
  await prisma.taskAssignee.delete({ where: { taskId_userId: { taskId, userId } } });
}

export async function addLabel(
  workspaceId: string,
  projectId: string,
  categoryId: string,
  taskId: string,
  labelId: string,
) {
  await getTaskOrThrow(workspaceId, categoryId, taskId);
  // Labels remain project-scoped (deliberately separate from Categories —
  // see docs/PHASES.md), so the label lookup below is still keyed by
  // projectId, not categoryId.
  const label = await prisma.label.findFirst({ where: { id: labelId, projectId, workspaceId } });
  if (!label) {
    throw new NotFoundError("This label doesn't exist in this project.");
  }
  return prisma.taskLabel.upsert({
    where: { taskId_labelId: { taskId, labelId } },
    update: {},
    create: { workspaceId, taskId, labelId },
  });
}

export async function removeLabel(workspaceId: string, categoryId: string, taskId: string, labelId: string) {
  await getTaskOrThrow(workspaceId, categoryId, taskId);
  const existing = await prisma.taskLabel.findUnique({ where: { taskId_labelId: { taskId, labelId } } });
  if (!existing) {
    throw new NotFoundError("This label is not attached to this task.");
  }
  await prisma.taskLabel.delete({ where: { taskId_labelId: { taskId, labelId } } });
}
