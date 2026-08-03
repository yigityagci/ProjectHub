import type { FastifyInstance } from "fastify";
import type { BulkTaskAction, Permission } from "@projecthub/shared";
import {
  createTaskSchema,
  updateTaskSchema,
  moveTaskSchema,
  addAssigneeSchema,
  createDependencySchema,
  taskListQuerySchema,
  bulkTaskActionSchema,
} from "@projecthub/shared";
import { ValidationError, NotFoundError, ForbiddenError } from "../core/errors.js";
import {
  requireAuth,
  requireCsrf,
  requireMembership,
  requireProjectAccess,
  requireCategoryAccess,
  requirePermission,
} from "../rbac/guards.js";
import {
  listTasks,
  getTaskOrThrow,
  createTask,
  updateTask,
  moveTask,
  deleteTask,
  addAssignee,
  removeAssignee,
  addLabel,
  removeLabel,
} from "./tasks.service.js";
import { bulkTaskAction } from "./tasks.bulk.service.js";
import { listDependencies, createDependency, removeDependency } from "./dependencies.service.js";
import { emitToCategory } from "../realtime/realtime.js";
import { createNotification } from "../notifications/notifications.service.js";
import { createActivityEvent, broadcastActivityEvent } from "../activity/activity.service.js";
import { prisma } from "../core/prisma.js";

/**
 * Bulk actions are permission-checked per action-type inside the handler
 * (not via one guard-chain requirePermission), since different actions
 * require different permissions. This is a `Record<BulkTaskAction,
 * Permission>` — deliberately total, not partial — so a future bulk action
 * can never ship without an explicit permission decision.
 */
const BULK_ACTION_PERMISSION: Record<BulkTaskAction, Permission> = {
  move: "task.edit",
  setPriority: "task.edit",
  addLabel: "task.edit",
  removeLabel: "task.edit",
  assign: "task.assign",
  unassign: "task.assign",
  delete: "task.delete",
};

/** Caps request amplification independent of the `taskIds` <= 100 Zod cap. */
const BULK_TASK_ACTION_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };

interface TaskWithRelations {
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
  assignees: { userId: string; user: { id: string; displayName: string; email: string } }[];
  labels: { labelId: string; label: { id: string; name: string; color: string } }[];
}

function serializeTask(task: TaskWithRelations) {
  return {
    id: task.id,
    projectId: task.projectId,
    categoryId: task.categoryId,
    columnId: task.columnId,
    parentTaskId: task.parentTaskId,
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
    })),
    labels: task.labels.map((l) => ({
      labelId: l.labelId,
      name: l.label.name,
      color: l.label.color,
    })),
  };
}

/**
 * Tasks are category-scoped: a task belongs to exactly one category
 * (implied by which category's board its column lives on). Every route
 * here sits under `.../categories/:categoryId/tasks...` and gets
 * requireCategoryAccess inserted immediately after requireProjectAccess —
 * a task from category A can never be reached via category B's URL, even
 * within the same project, because every service call below is scoped by
 * `req.ctx.category!.id`, never merely `req.ctx.project!.id`.
 */
export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess, requireCategoryAccess] },
    async (req, reply) => {
      const parsed = taskListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid filter parameters.");
      }
      // req.ctx.category!.id is always derived from requireCategoryAccess
      // (the URL's :categoryId, already verified against the caller's live
      // workspace+project+category access) — never from the query string,
      // so these filters can only ever narrow this same category's tasks.
      const tasks = await listTasks(req.ctx.category!.id, parsed.data);
      return reply.send({ tasks: tasks.map(serializeTask) });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("task.create"),
      ],
    },
    async (req, reply) => {
      const parsed = createTaskSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const task = await createTask({
        workspaceId: req.ctx.workspace!.id,
        projectId: req.ctx.project!.id,
        categoryId: req.ctx.category!.id,
        creatorId: req.ctx.user!.id,
        creatorDisplayName: req.ctx.user!.displayName,
        input: parsed.data,
      });
      const serialized = serializeTask(task);
      emitToCategory(req.ctx.category!.id, "task.created", serialized);
      return reply.code(201).send({ task: serialized });
    },
  );

  /**
   * Bulk task actions. Permission is deliberately checked in-handler
   * against BULK_ACTION_PERMISSION (per action-type), not via a single
   * requirePermission(...) preHandler — different actions require
   * different permissions. Always 200 on a well-formed, permitted request,
   * even if every task in the batch errored: a partial failure is visible
   * per-task in `results`, never collapsed into one whole-batch pass/fail.
   */
  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks/bulk",
    {
      config: { rateLimit: BULK_TASK_ACTION_RATE_LIMIT },
      preHandler: [requireAuth, requireCsrf, requireMembership, requireProjectAccess, requireCategoryAccess],
    },
    async (req, reply) => {
      const parsed = bulkTaskActionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      const requiredPermission = BULK_ACTION_PERMISSION[parsed.data.action];
      if (!req.ctx.permissions?.has(requiredPermission)) {
        throw new ForbiddenError();
      }

      const result = await bulkTaskAction({
        workspaceId: req.ctx.workspace!.id,
        projectId: req.ctx.project!.id,
        categoryId: req.ctx.category!.id,
        actor: { id: req.ctx.user!.id, displayName: req.ctx.user!.displayName },
        input: parsed.data,
      });

      for (const item of result.results) {
        if (item.status !== "success") continue;
        if (result.action === "delete") {
          emitToCategory(req.ctx.category!.id, "task.deleted", { id: item.taskId });
        } else if (item.task) {
          const serialized = serializeTask(item.task);
          emitToCategory(req.ctx.category!.id, result.action === "move" ? "task.moved" : "task.updated", serialized);
        }
      }
      for (const cascadedId of result.cascadedDeletedTaskIds) {
        emitToCategory(req.ctx.category!.id, "task.deleted", { id: cascadedId });
      }
      for (const notif of result.assignedNotifications) {
        await createNotification({
          workspaceId: req.ctx.workspace!.id,
          recipientUserId: notif.recipientUserId,
          type: "task_assigned",
          payload: {
            taskId: notif.taskId,
            projectId: req.ctx.project!.id,
            categoryId: req.ctx.category!.id,
            assignedBy: req.ctx.user!.id,
          },
        });
      }

      const summary = {
        requested: result.results.length,
        succeeded: result.results.filter((r) => r.status === "success").length,
        failed: result.results.filter((r) => r.status === "error").length,
      };

      return reply.code(200).send({
        action: result.action,
        results: result.results.map((r) =>
          r.status === "success"
            ? { taskId: r.taskId, status: "success", task: r.task ? serializeTask(r.task) : null }
            : {
                taskId: r.taskId,
                status: "error",
                code: r.code,
                message: r.message,
                currentTask: r.currentTask ? serializeTask(r.currentTask) : null,
              },
        ),
        summary,
      });
    },
  );

  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks/:taskId",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess, requireCategoryAccess] },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      const task = await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.category!.id, taskId);
      return reply.send({ task: serializeTask(task) });
    },
  );

  app.patch(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks/:taskId",
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
      const parsed = updateTaskSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { taskId } = req.params as { taskId: string };

      const result = await updateTask(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        req.ctx.category!.id,
        taskId,
        parsed.data,
      );

      if (result.conflict) {
        return reply.code(409).send({
          error: {
            code: "VERSION_CONFLICT",
            message:
              "This task was changed by someone else. Refresh to see the latest version and try again.",
            requestId: req.id,
          },
          currentTask: serializeTask(result.currentTask),
        });
      }

      const serialized = serializeTask(result.task);
      emitToCategory(req.ctx.category!.id, "task.updated", serialized);
      return reply.code(200).send({ task: serialized });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks/:taskId/move",
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
      const parsed = moveTaskSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { taskId } = req.params as { taskId: string };

      const result = await moveTask(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        req.ctx.category!.id,
        taskId,
        parsed.data,
        { id: req.ctx.user!.id, displayName: req.ctx.user!.displayName },
      );

      if (result.conflict) {
        return reply.code(409).send({
          error: {
            code: "VERSION_CONFLICT",
            message:
              "This task was changed by someone else. Refresh to see the latest version and try again.",
            requestId: req.id,
          },
          currentTask: serializeTask(result.currentTask),
        });
      }

      const serialized = serializeTask(result.task);
      emitToCategory(req.ctx.category!.id, "task.moved", serialized);
      return reply.code(200).send({ task: serialized });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks/:taskId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("task.delete"),
      ],
    },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      await deleteTask(req.ctx.workspace!.id, req.ctx.category!.id, taskId);
      emitToCategory(req.ctx.category!.id, "task.deleted", { id: taskId });
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks/:taskId/assignees",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("task.assign"),
      ],
    },
    async (req, reply) => {
      const parsed = addAssigneeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { taskId } = req.params as { taskId: string };
      await addAssignee(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        req.ctx.category!.id,
        taskId,
        parsed.data.userId,
      );
      const updatedTask = await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.category!.id, taskId);
      emitToCategory(req.ctx.category!.id, "task.updated", serializeTask(updatedTask));

      const assigneeDisplayName =
        updatedTask.assignees.find((a) => a.userId === parsed.data.userId)?.user.displayName ?? "Unknown";
      const activityEvent = await createActivityEvent(prisma, {
        workspaceId: req.ctx.workspace!.id,
        projectId: req.ctx.project!.id,
        categoryId: req.ctx.category!.id,
        actorId: req.ctx.user!.id,
        type: "task_assigned",
        payload: {
          taskId,
          taskTitle: updatedTask.title,
          assigneeId: parsed.data.userId,
          assigneeDisplayName,
          actorDisplayName: req.ctx.user!.displayName,
        },
      });
      broadcastActivityEvent(activityEvent);

      if (parsed.data.userId !== req.ctx.user!.id) {
        await createNotification({
          workspaceId: req.ctx.workspace!.id,
          recipientUserId: parsed.data.userId,
          type: "task_assigned",
          payload: {
            taskId,
            projectId: req.ctx.project!.id,
            categoryId: req.ctx.category!.id,
            assignedBy: req.ctx.user!.id,
          },
        });
      }
      return reply.code(201).send({ ok: true });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks/:taskId/assignees/:userId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("task.assign"),
      ],
    },
    async (req, reply) => {
      const { taskId, userId } = req.params as { taskId: string; userId: string };
      await removeAssignee(req.ctx.workspace!.id, req.ctx.category!.id, taskId, userId);
      const updatedTask = await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.category!.id, taskId);
      emitToCategory(req.ctx.category!.id, "task.updated", serializeTask(updatedTask));
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks/:taskId/labels/:labelId",
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
      const { taskId, labelId } = req.params as { taskId: string; labelId: string };
      await addLabel(req.ctx.workspace!.id, req.ctx.project!.id, req.ctx.category!.id, taskId, labelId);
      const updatedTask = await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.category!.id, taskId);
      emitToCategory(req.ctx.category!.id, "task.updated", serializeTask(updatedTask));
      return reply.code(201).send({ ok: true });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks/:taskId/labels/:labelId",
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
      const { taskId, labelId } = req.params as { taskId: string; labelId: string };
      await removeLabel(req.ctx.workspace!.id, req.ctx.category!.id, taskId, labelId);
      const updatedTask = await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.category!.id, taskId);
      emitToCategory(req.ctx.category!.id, "task.updated", serializeTask(updatedTask));
      return reply.send({ ok: true });
    },
  );

  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks/:taskId/dependencies",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess, requireCategoryAccess] },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.category!.id, taskId);
      const dependencies = await listDependencies(req.ctx.project!.id, taskId);
      return reply.send({ dependencies });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks/:taskId/dependencies",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("dependency.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = createDependencySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { taskId } = req.params as { taskId: string };
      // The blocked task must belong to this category (verified via
      // getTaskOrThrow); the blocking task only needs to belong to the same
      // project — dependencies are deliberately still project-scoped (a
      // task in one category can depend on a task in a sibling category of
      // the same project), unaffected by the category isolation model.
      await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.category!.id, taskId);
      const dependency = await createDependency(
        req.ctx.workspace!.id,
        req.ctx.project!.id,
        taskId,
        parsed.data.blockingTaskId,
      );
      return reply.code(201).send({ dependency });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId/tasks/:taskId/dependencies/:depId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requireCategoryAccess,
        requirePermission("dependency.manage"),
      ],
    },
    async (req, reply) => {
      const { taskId, depId } = req.params as { taskId: string; depId: string };
      if (!depId) {
        throw new NotFoundError("This dependency doesn't exist for this task.");
      }
      await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.category!.id, taskId);
      await removeDependency(req.ctx.project!.id, taskId, depId);
      return reply.send({ ok: true });
    },
  );
}
