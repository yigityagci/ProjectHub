import type { UserStatus } from "@prisma/client";
import { parseRecurrenceRule } from "@projecthub/shared";
import { isDeletedUser } from "../users/user-serialization.js";

/**
 * Extracted from tasks.routes.ts (see users/user-serialization.ts for the
 * precedent this mirrors): a small, dedicated, side-effect-free
 * serialization module shared by every route/service that turns a raw
 * Prisma task row (with its relations) into the wire shape the frontend
 * consumes.
 */
export interface TaskWithRelations {
  id: string;
  projectId: string;
  categoryId: string;
  columnId: string;
  parentTaskId: string | null;
  milestoneId: string | null;
  title: string;
  description: string | null;
  priority: string;
  position: number;
  creatorId: string;
  startDate: Date | null;
  dueDate: Date | null;
  completedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  assignees: { userId: string; user: { id: string; displayName: string; email: string; status: UserStatus } }[];
  labels: { labelId: string; label: { id: string; name: string; color: string } }[];
  // Recurring tasks (see the doc comment on Task.recurrenceTemplateId in
  // schema.prisma).
  recurrenceRule: unknown;
  nextRunAt: Date | null;
  recurrenceCount: number;
  recurrenceTemplateId: string | null;
  recurrenceTemplate: { id: string; title: string } | null;
}

export function serializeTask(task: TaskWithRelations) {
  return {
    id: task.id,
    projectId: task.projectId,
    categoryId: task.categoryId,
    columnId: task.columnId,
    parentTaskId: task.parentTaskId,
    // No separate `isRecurrenceTemplate` boolean — the frontend derives that
    // from `recurrenceRule !== null`.
    recurrenceRule: parseRecurrenceRule(task.recurrenceRule),
    nextRunAt: task.nextRunAt,
    recurrenceCount: task.recurrenceCount,
    recurrenceTemplateId: task.recurrenceTemplateId,
    recurrenceTemplateTitle: task.recurrenceTemplate?.title ?? null,
    milestoneId: task.milestoneId,
    title: task.title,
    description: task.description,
    priority: task.priority,
    position: task.position,
    creatorId: task.creatorId,
    startDate: task.startDate,
    dueDate: task.dueDate,
    completedAt: task.completedAt,
    version: task.version,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    assignees: task.assignees.map((a) => ({
      userId: a.userId,
      displayName: a.user.displayName,
      email: a.user.email,
      isDeleted: isDeletedUser(a.user),
    })),
    labels: task.labels.map((l) => ({
      labelId: l.labelId,
      name: l.label.name,
      color: l.label.color,
    })),
  };
}
