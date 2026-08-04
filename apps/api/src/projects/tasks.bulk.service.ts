import type { ActivityEvent } from "@prisma/client";
import type { BulkTaskAction, BulkTaskActionInput, BulkTaskErrorCode } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { computeAppendPosition } from "./position.js";
import { createActivityEvent, broadcastActivityEvent } from "../activity/activity.service.js";
import { getTaskOrThrow, DONE_CATEGORY, TASK_NOT_FOUND_MESSAGE } from "./tasks.service.js";

/**
 * Structurally identical to what `getTaskOrThrow` returns / what
 * `serializeTask` in tasks.routes.ts accepts — reused here rather than
 * redefined so the two shapes can never silently drift apart.
 */
export type TaskWithRelations = NonNullable<Awaited<ReturnType<typeof getTaskOrThrow>>>;

const TASK_INCLUDE = {
  assignees: { include: { user: true } },
  labels: { include: { label: true } },
  recurrenceTemplate: { select: { id: true, title: true } },
} as const;

const VERSION_CONFLICT_MESSAGE =
  "This task was changed by someone else. Refresh to see the latest version and try again.";

export type BulkTaskItemResult =
  | { taskId: string; status: "success"; task: TaskWithRelations | null }
  | {
      taskId: string;
      status: "error";
      code: BulkTaskErrorCode;
      message: string;
      currentTask: TaskWithRelations | null;
    };

export interface BulkTaskActionResult {
  action: BulkTaskAction;
  results: BulkTaskItemResult[];
  /** Ids removed by the Task.parentTask onDelete: Cascade, excluding ids
   * already in `results`. Non-empty only for "delete". */
  cascadedDeletedTaskIds: string[];
  /** Recipients for post-commit notification fan-out. Non-empty only for "assign". */
  assignedNotifications: Array<{ taskId: string; taskTitle: string; recipientUserId: string }>;
}

export interface BulkTaskActionParams {
  workspaceId: string;
  projectId: string;
  categoryId: string;
  actor: { id: string; displayName: string };
  input: BulkTaskActionInput;
}

async function validateMoveTargetColumn(workspaceId: string, categoryId: string, columnId: string) {
  const column = await prisma.boardColumn.findFirst({ where: { id: columnId, categoryId, workspaceId } });
  if (!column) {
    throw new ValidationError("This column doesn't belong to this category.");
  }
  return column;
}

async function validateActiveWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!membership || membership.status !== "active") {
    throw new ValidationError("This user is not an active member of this workspace.");
  }
}

async function validateProjectLabel(workspaceId: string, projectId: string, labelId: string): Promise<void> {
  const label = await prisma.label.findFirst({ where: { id: labelId, projectId, workspaceId } });
  if (!label) {
    throw new NotFoundError("This label doesn't exist in this project.");
  }
}

/**
 * Executes a bulk task action for a single, already-authorized (permission
 * checked by the caller, per action-type) request. Conflicts are values,
 * never exceptions: every write below is count-based (`updateMany`/
 * `createMany`/`deleteMany`), so a per-task failure (version conflict, or a
 * requested id that doesn't belong to this category) can never poison the
 * single enclosing transaction the way a thrown DB error would.
 */
export async function bulkTaskAction(params: BulkTaskActionParams): Promise<BulkTaskActionResult> {
  const { workspaceId, projectId, categoryId, actor, input } = params;
  // Bulk actions are set operations: duplicate requested ids collapse to
  // one result entry each, in original request order.
  const uniqueTaskIds = Array.from(new Set(input.taskIds));

  // Pre-transaction, whole-request validation: any failure here closes the
  // whole request (422/404), never a per-task result.
  let targetColumn: { id: string; name: string; category: string } | null = null;
  if (input.action === "move") {
    targetColumn = await validateMoveTargetColumn(workspaceId, categoryId, input.columnId);
  } else if (input.action === "assign") {
    await validateActiveWorkspaceMember(workspaceId, input.userId);
  } else if (input.action === "addLabel" || input.action === "removeLabel") {
    await validateProjectLabel(workspaceId, projectId, input.labelId);
  }

  const activityEventsToBroadcast: ActivityEvent[] = [];
  const assignedNotifications: Array<{ taskId: string; taskTitle: string; recipientUserId: string }> = [];
  let cascadedDeletedTaskIds: string[] = [];

  const { results } = await prisma.$transaction(
    async (tx) => {
      // Single eligibility read, scoped to this category/workspace only —
      // never a fallback probe outside it. Any requested id not present
      // here becomes a per-task NOT_IN_CATEGORY result below.
      const eligibleTasks = await tx.task.findMany({
        where: { id: { in: uniqueTaskIds }, workspaceId, categoryId },
        include: { column: true },
      });
      const eligibleMap = new Map(eligibleTasks.map((t) => [t.id, t]));
      const eligibleIds = eligibleTasks.map((t) => t.id);

      const writeOutcome = new Map<string, "success" | "conflict">();

      switch (input.action) {
        case "move": {
          const runningMaxTask = await tx.task.findFirst({
            where: { categoryId, columnId: input.columnId, id: { notIn: eligibleIds } },
            orderBy: { position: "desc" },
          });
          let runningMax = runningMaxTask?.position ?? null;

          for (const taskId of uniqueTaskIds) {
            const current = eligibleMap.get(taskId);
            if (!current) continue;

            const version = input.versions[taskId];
            let completedAtUpdate: Date | null | undefined;
            if (targetColumn!.category === DONE_CATEGORY && current.column.category !== DONE_CATEGORY) {
              completedAtUpdate = new Date();
            } else if (
              targetColumn!.category !== DONE_CATEGORY &&
              current.column.category === DONE_CATEGORY
            ) {
              completedAtUpdate = null;
            }

            const position = computeAppendPosition(runningMax);
            const writeResult = await tx.task.updateMany({
              where: { id: taskId, workspaceId, categoryId, version },
              data: {
                columnId: input.columnId,
                position,
                version: { increment: 1 },
                ...(completedAtUpdate !== undefined ? { completedAt: completedAtUpdate } : {}),
              },
            });

            if (writeResult.count === 1) {
              writeOutcome.set(taskId, "success");
              runningMax = position;
              if (current.columnId !== input.columnId) {
                const event = await createActivityEvent(tx, {
                  workspaceId,
                  projectId,
                  categoryId,
                  actorId: actor.id,
                  type: "task_moved",
                  payload: {
                    taskId,
                    taskTitle: current.title,
                    fromColumnId: current.columnId,
                    fromColumnName: current.column.name,
                    toColumnId: targetColumn!.id,
                    toColumnName: targetColumn!.name,
                    actorDisplayName: actor.displayName,
                  },
                });
                activityEventsToBroadcast.push(event);
              }
            } else {
              writeOutcome.set(taskId, "conflict");
            }
          }
          break;
        }

        case "setPriority": {
          for (const taskId of uniqueTaskIds) {
            const current = eligibleMap.get(taskId);
            if (!current) continue;
            const version = input.versions[taskId];
            const writeResult = await tx.task.updateMany({
              where: { id: taskId, workspaceId, categoryId, version },
              data: { priority: input.priority, version: { increment: 1 } },
            });
            writeOutcome.set(taskId, writeResult.count === 1 ? "success" : "conflict");
          }
          break;
        }

        case "assign": {
          if (eligibleIds.length > 0) {
            await tx.taskAssignee.createMany({
              data: eligibleIds.map((id) => ({ workspaceId, taskId: id, userId: input.userId })),
              skipDuplicates: true,
            });
          }
          if (eligibleIds.length > 0) {
            const assigneeUser = await tx.user.findUnique({
              where: { id: input.userId },
              select: { displayName: true },
            });
            const assigneeDisplayName = assigneeUser?.displayName ?? "Unknown";
            for (const taskId of eligibleIds) {
              writeOutcome.set(taskId, "success");
              const current = eligibleMap.get(taskId)!;
              const event = await createActivityEvent(tx, {
                workspaceId,
                projectId,
                categoryId,
                actorId: actor.id,
                type: "task_assigned",
                payload: {
                  taskId,
                  taskTitle: current.title,
                  assigneeId: input.userId,
                  assigneeDisplayName,
                  actorDisplayName: actor.displayName,
                },
              });
              activityEventsToBroadcast.push(event);
              if (input.userId !== actor.id) {
                assignedNotifications.push({ taskId, taskTitle: current.title, recipientUserId: input.userId });
              }
            }
          }
          break;
        }

        case "unassign": {
          if (eligibleIds.length > 0) {
            await tx.taskAssignee.deleteMany({
              where: { taskId: { in: eligibleIds }, userId: input.userId, workspaceId },
            });
          }
          for (const taskId of eligibleIds) writeOutcome.set(taskId, "success");
          break;
        }

        case "addLabel": {
          if (eligibleIds.length > 0) {
            await tx.taskLabel.createMany({
              data: eligibleIds.map((id) => ({ workspaceId, taskId: id, labelId: input.labelId })),
              skipDuplicates: true,
            });
          }
          for (const taskId of eligibleIds) writeOutcome.set(taskId, "success");
          break;
        }

        case "removeLabel": {
          if (eligibleIds.length > 0) {
            await tx.taskLabel.deleteMany({
              where: { taskId: { in: eligibleIds }, labelId: input.labelId, workspaceId },
            });
          }
          for (const taskId of eligibleIds) writeOutcome.set(taskId, "success");
          break;
        }

        case "delete": {
          if (eligibleIds.length > 0) {
            // Capture subtasks that will be cascade-removed by the FK
            // (Task.parentTask onDelete: Cascade) BEFORE issuing the
            // delete, so callers can broadcast task.deleted for them too.
            const cascaded = await tx.task.findMany({
              where: { workspaceId, categoryId, parentTaskId: { in: eligibleIds } },
              select: { id: true },
            });
            cascadedDeletedTaskIds = cascaded.map((t) => t.id).filter((id) => !eligibleIds.includes(id));

            // One set-based deleteMany, never per-row delete: a per-row
            // delete would throw P2025 for a subtask already removed by
            // the cascade of an earlier row in the same batch.
            await tx.task.deleteMany({ where: { id: { in: eligibleIds }, workspaceId, categoryId } });
          }
          for (const taskId of eligibleIds) writeOutcome.set(taskId, "success");
          break;
        }
      }

      const successIds = [...writeOutcome.entries()].filter(([, v]) => v === "success").map(([id]) => id);
      const conflictIds = [...writeOutcome.entries()].filter(([, v]) => v === "conflict").map(([id]) => id);

      const freshSuccessMap = new Map<string, TaskWithRelations>();
      if (input.action !== "delete" && successIds.length > 0) {
        const fresh = await tx.task.findMany({
          where: { id: { in: successIds }, workspaceId, categoryId },
          include: TASK_INCLUDE,
        });
        for (const task of fresh) freshSuccessMap.set(task.id, task);
      }

      const freshConflictMap = new Map<string, TaskWithRelations>();
      if (conflictIds.length > 0) {
        const fresh = await tx.task.findMany({
          where: { id: { in: conflictIds }, workspaceId, categoryId },
          include: TASK_INCLUDE,
        });
        for (const task of fresh) freshConflictMap.set(task.id, task);
      }

      const builtResults: BulkTaskItemResult[] = uniqueTaskIds.map((taskId) => {
        const outcome = writeOutcome.get(taskId);
        if (!outcome) {
          return {
            taskId,
            status: "error",
            code: "NOT_IN_CATEGORY",
            message: TASK_NOT_FOUND_MESSAGE,
            currentTask: null,
          };
        }
        if (outcome === "success") {
          return {
            taskId,
            status: "success",
            task: input.action === "delete" ? null : (freshSuccessMap.get(taskId) ?? null),
          };
        }
        return {
          taskId,
          status: "error",
          code: "VERSION_CONFLICT",
          message: VERSION_CONFLICT_MESSAGE,
          currentTask: freshConflictMap.get(taskId) ?? null,
        };
      });

      return { results: builtResults };
    },
    { timeout: 15000 },
  );

  // Broadcast only after the transaction has actually committed — a
  // subsequently rolled-back mutation can never produce a phantom live
  // event.
  for (const event of activityEventsToBroadcast) {
    broadcastActivityEvent(event);
  }

  return {
    action: input.action,
    results,
    cascadedDeletedTaskIds,
    assignedNotifications,
  };
}
