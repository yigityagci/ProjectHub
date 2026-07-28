import type { FastifyInstance } from "fastify";
import {
  createTaskSchema,
  updateTaskSchema,
  moveTaskSchema,
  addAssigneeSchema,
  createDependencySchema,
  taskListQuerySchema,
} from "@projecthub/shared";
import { ValidationError, NotFoundError } from "../core/errors.js";
import {
  requireAuth,
  requireCsrf,
  requireMembership,
  requireProjectAccess,
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
import { listDependencies, createDependency, removeDependency } from "./dependencies.service.js";
import { emitToProject } from "../realtime/realtime.js";
import { createNotification } from "../notifications/notifications.service.js";
import { createActivityEvent, broadcastActivityEvent } from "../activity/activity.service.js";
import { prisma } from "../core/prisma.js";

interface TaskWithRelations {
  id: string;
  projectId: string;
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

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/tasks",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const parsed = taskListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid filter parameters.");
      }
      // req.ctx.project!.id is always derived from requireProjectAccess (the
      // URL's :projectId, already verified against the caller's live
      // workspace+project membership) — never from the query string, so
      // these filters can only ever narrow this same project's tasks.
      const tasks = await listTasks(req.ctx.project!.id, parsed.data);
      return reply.send({ tasks: tasks.map(serializeTask) });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/tasks",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
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
        creatorId: req.ctx.user!.id,
        creatorDisplayName: req.ctx.user!.displayName,
        input: parsed.data,
      });
      const serialized = serializeTask(task);
      emitToProject(req.ctx.project!.id, "task.created", serialized);
      return reply.code(201).send({ task: serialized });
    },
  );

  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      const task = await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.project!.id, taskId);
      return reply.send({ task: serializeTask(task) });
    },
  );

  app.patch(
    "/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("task.edit"),
      ],
    },
    async (req, reply) => {
      const parsed = updateTaskSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { taskId } = req.params as { taskId: string };

      const result = await updateTask(req.ctx.workspace!.id, req.ctx.project!.id, taskId, parsed.data);

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
      emitToProject(req.ctx.project!.id, "task.updated", serialized);
      return reply.code(200).send({ task: serialized });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/move",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("task.edit"),
      ],
    },
    async (req, reply) => {
      const parsed = moveTaskSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { taskId } = req.params as { taskId: string };

      const result = await moveTask(req.ctx.workspace!.id, req.ctx.project!.id, taskId, parsed.data, {
        id: req.ctx.user!.id,
        displayName: req.ctx.user!.displayName,
      });

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
      emitToProject(req.ctx.project!.id, "task.moved", serialized);
      return reply.code(200).send({ task: serialized });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("task.delete"),
      ],
    },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      await deleteTask(req.ctx.workspace!.id, req.ctx.project!.id, taskId);
      emitToProject(req.ctx.project!.id, "task.deleted", { id: taskId });
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/assignees",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("task.assign"),
      ],
    },
    async (req, reply) => {
      const parsed = addAssigneeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { taskId } = req.params as { taskId: string };
      await addAssignee(req.ctx.workspace!.id, req.ctx.project!.id, taskId, parsed.data.userId);
      const updatedTask = await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.project!.id, taskId);
      emitToProject(req.ctx.project!.id, "task.updated", serializeTask(updatedTask));

      const assigneeDisplayName =
        updatedTask.assignees.find((a) => a.userId === parsed.data.userId)?.user.displayName ?? "Unknown";
      const activityEvent = await createActivityEvent(prisma, {
        workspaceId: req.ctx.workspace!.id,
        projectId: req.ctx.project!.id,
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
          payload: { taskId, projectId: req.ctx.project!.id, assignedBy: req.ctx.user!.id },
        });
      }
      return reply.code(201).send({ ok: true });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/assignees/:userId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("task.assign"),
      ],
    },
    async (req, reply) => {
      const { taskId, userId } = req.params as { taskId: string; userId: string };
      await removeAssignee(req.ctx.workspace!.id, req.ctx.project!.id, taskId, userId);
      const updatedTask = await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.project!.id, taskId);
      emitToProject(req.ctx.project!.id, "task.updated", serializeTask(updatedTask));
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/labels/:labelId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("task.edit"),
      ],
    },
    async (req, reply) => {
      const { taskId, labelId } = req.params as { taskId: string; labelId: string };
      await addLabel(req.ctx.workspace!.id, req.ctx.project!.id, taskId, labelId);
      const updatedTask = await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.project!.id, taskId);
      emitToProject(req.ctx.project!.id, "task.updated", serializeTask(updatedTask));
      return reply.code(201).send({ ok: true });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/labels/:labelId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("task.edit"),
      ],
    },
    async (req, reply) => {
      const { taskId, labelId } = req.params as { taskId: string; labelId: string };
      await removeLabel(req.ctx.workspace!.id, req.ctx.project!.id, taskId, labelId);
      const updatedTask = await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.project!.id, taskId);
      emitToProject(req.ctx.project!.id, "task.updated", serializeTask(updatedTask));
      return reply.send({ ok: true });
    },
  );

  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dependencies",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      await getTaskOrThrow(req.ctx.workspace!.id, req.ctx.project!.id, taskId);
      const dependencies = await listDependencies(req.ctx.project!.id, taskId);
      return reply.send({ dependencies });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dependencies",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("dependency.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = createDependencySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { taskId } = req.params as { taskId: string };
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
    "/api/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dependencies/:depId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("dependency.manage"),
      ],
    },
    async (req, reply) => {
      const { taskId, depId } = req.params as { taskId: string; depId: string };
      if (!depId) {
        throw new NotFoundError("This dependency doesn't exist for this task.");
      }
      await removeDependency(req.ctx.project!.id, taskId, depId);
      return reply.send({ ok: true });
    },
  );
}
