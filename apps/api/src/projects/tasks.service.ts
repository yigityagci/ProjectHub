import type { CreateTaskInput, UpdateTaskInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { computeAppendPosition, computeInsertPosition } from "./position.js";

const TASK_NOT_FOUND_MESSAGE = "This task doesn't exist in this project.";

export async function listTasks(projectId: string) {
  return prisma.task.findMany({
    where: { projectId },
    include: {
      assignees: { include: { user: true } },
      labels: { include: { label: true } },
    },
    orderBy: [{ columnId: "asc" }, { position: "asc" }],
  });
}

export async function getTaskOrThrow(workspaceId: string, projectId: string, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId, projectId },
    include: {
      assignees: { include: { user: true } },
      labels: { include: { label: true } },
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
 *  - the parent must exist within the same workspace/project
 *  - the parent must not itself be a subtask (parent.parentTaskId === null)
 *  - the child must not already be a parent of other tasks
 */
async function validateSubtaskNesting(
  workspaceId: string,
  projectId: string,
  childTaskId: string,
  parentTaskId: string,
): Promise<void> {
  if (parentTaskId === childTaskId) {
    throw new ValidationError("A task cannot be its own subtask.");
  }

  const parent = await prisma.task.findFirst({
    where: { id: parentTaskId, workspaceId, projectId },
  });
  if (!parent) {
    throw new ValidationError("The parent task must belong to the same project.");
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

async function resolveDefaultColumnId(projectId: string): Promise<string> {
  const column = await prisma.boardColumn.findFirst({
    where: { projectId },
    orderBy: { position: "asc" },
  });
  if (!column) {
    throw new ValidationError("This project has no board columns to add a task to.");
  }
  return column.id;
}

export interface CreateTaskParams {
  workspaceId: string;
  projectId: string;
  creatorId: string;
  input: CreateTaskInput;
}

export async function createTask(params: CreateTaskParams) {
  const { workspaceId, projectId, creatorId, input } = params;

  let columnId = input.columnId;
  if (columnId) {
    const column = await prisma.boardColumn.findFirst({ where: { id: columnId, projectId, workspaceId } });
    if (!column) {
      throw new ValidationError("This column doesn't belong to this project.");
    }
  } else {
    columnId = await resolveDefaultColumnId(projectId);
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
      where: { id: input.parentTaskId, workspaceId, projectId },
    });
    if (!parent) {
      throw new ValidationError("The parent task must belong to the same project.");
    }
    if (parent.parentTaskId !== null) {
      throw new ValidationError(
        "Subtasks can only be nested one level deep: a subtask cannot itself have subtasks.",
      );
    }
    parentTaskId = parent.id;
  }

  const maxPositionTask = await prisma.task.findFirst({
    where: { projectId, columnId },
    orderBy: { position: "desc" },
  });

  return prisma.task.create({
    data: {
      workspaceId,
      projectId,
      columnId,
      parentTaskId,
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
    },
  });
}

export type UpdateTaskResult =
  | { conflict: false; task: NonNullable<Awaited<ReturnType<typeof getTaskOrThrow>>> }
  | { conflict: true; currentTask: NonNullable<Awaited<ReturnType<typeof getTaskOrThrow>>> };

export async function updateTask(
  workspaceId: string,
  projectId: string,
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
    await validateSubtaskNesting(workspaceId, projectId, taskId, input.parentTaskId);
  }

  const { version, ...rest } = input;
  const data: Record<string, unknown> = {};
  if (rest.title !== undefined) data.title = rest.title;
  if (rest.description !== undefined) data.description = rest.description;
  if (rest.priority !== undefined) data.priority = rest.priority;
  if (rest.parentTaskId !== undefined) data.parentTaskId = rest.parentTaskId;
  if (rest.milestoneId !== undefined) data.milestoneId = rest.milestoneId;
  if (rest.startDate !== undefined) data.startDate = rest.startDate;
  if (rest.dueDate !== undefined) data.dueDate = rest.dueDate;

  const result = await prisma.task.updateMany({
    where: { id: taskId, workspaceId, projectId, version },
    data: { ...data, version: { increment: 1 } },
  });

  if (result.count === 0) {
    const current = await prisma.task.findFirst({
      where: { id: taskId, workspaceId, projectId },
      include: { assignees: { include: { user: true } }, labels: { include: { label: true } } },
    });
    if (!current) {
      throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);
    }
    return { conflict: true, currentTask: current };
  }

  const updated = await getTaskOrThrow(workspaceId, projectId, taskId);
  return { conflict: false, task: updated };
}

export interface MoveTaskInputResolved {
  version: number;
  columnId: string;
  beforeTaskId?: string | null;
  afterTaskId?: string | null;
}

export async function moveTask(
  workspaceId: string,
  projectId: string,
  taskId: string,
  input: MoveTaskInputResolved,
): Promise<UpdateTaskResult> {
  const targetColumn = await prisma.boardColumn.findFirst({
    where: { id: input.columnId, projectId, workspaceId },
  });
  if (!targetColumn) {
    throw new ValidationError("This column doesn't belong to this project.");
  }

  let prevPosition: number | null = null;
  let nextPosition: number | null = null;

  if (input.beforeTaskId) {
    const before = await prisma.task.findFirst({
      where: { id: input.beforeTaskId, projectId, workspaceId, columnId: input.columnId },
    });
    if (!before) {
      throw new ValidationError("beforeTaskId must be an existing task in the target column.");
    }
    prevPosition = before.position;
  }
  if (input.afterTaskId) {
    const after = await prisma.task.findFirst({
      where: { id: input.afterTaskId, projectId, workspaceId, columnId: input.columnId },
    });
    if (!after) {
      throw new ValidationError("afterTaskId must be an existing task in the target column.");
    }
    nextPosition = after.position;
  }

  if (prevPosition === null && nextPosition === null) {
    const maxPositionTask = await prisma.task.findFirst({
      where: { projectId, columnId: input.columnId, id: { not: taskId } },
      orderBy: { position: "desc" },
    });
    prevPosition = maxPositionTask?.position ?? null;
  }

  let { position, needsRebalance } = computeInsertPosition(prevPosition, nextPosition);

  if (needsRebalance) {
    const siblings = await prisma.task.findMany({
      where: { projectId, columnId: input.columnId, id: { not: taskId } },
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

  const result = await prisma.task.updateMany({
    where: { id: taskId, workspaceId, projectId, version: input.version },
    data: { columnId: input.columnId, position, version: { increment: 1 } },
  });

  if (result.count === 0) {
    const current = await prisma.task.findFirst({
      where: { id: taskId, workspaceId, projectId },
      include: { assignees: { include: { user: true } }, labels: { include: { label: true } } },
    });
    if (!current) {
      throw new NotFoundError(TASK_NOT_FOUND_MESSAGE);
    }
    return { conflict: true, currentTask: current };
  }

  const updated = await getTaskOrThrow(workspaceId, projectId, taskId);
  return { conflict: false, task: updated };
}

export async function deleteTask(workspaceId: string, projectId: string, taskId: string) {
  await getTaskOrThrow(workspaceId, projectId, taskId);
  await prisma.task.delete({ where: { id: taskId } });
}

export async function addAssignee(workspaceId: string, projectId: string, taskId: string, userId: string) {
  await getTaskOrThrow(workspaceId, projectId, taskId);

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

export async function removeAssignee(workspaceId: string, projectId: string, taskId: string, userId: string) {
  await getTaskOrThrow(workspaceId, projectId, taskId);
  const existing = await prisma.taskAssignee.findUnique({ where: { taskId_userId: { taskId, userId } } });
  if (!existing) {
    throw new NotFoundError("This user is not assigned to this task.");
  }
  await prisma.taskAssignee.delete({ where: { taskId_userId: { taskId, userId } } });
}

export async function addLabel(workspaceId: string, projectId: string, taskId: string, labelId: string) {
  await getTaskOrThrow(workspaceId, projectId, taskId);
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

export async function removeLabel(workspaceId: string, projectId: string, taskId: string, labelId: string) {
  await getTaskOrThrow(workspaceId, projectId, taskId);
  const existing = await prisma.taskLabel.findUnique({ where: { taskId_labelId: { taskId, labelId } } });
  if (!existing) {
    throw new NotFoundError("This label is not attached to this task.");
  }
  await prisma.taskLabel.delete({ where: { taskId_labelId: { taskId, labelId } } });
}
