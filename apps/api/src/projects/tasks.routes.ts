import type { FastifyInstance } from "fastify";
import {
  createTaskSchema,
  updateTaskSchema,
  moveTaskSchema,
  addAssigneeSchema,
  createDependencySchema,
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
      const tasks = await listTasks(req.ctx.project!.id);
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
        input: parsed.data,
      });
      return reply.code(201).send({ task: serializeTask(task) });
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

      return reply.code(200).send({ task: serializeTask(result.task) });
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

      const result = await moveTask(req.ctx.workspace!.id, req.ctx.project!.id, taskId, parsed.data);

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

      return reply.code(200).send({ task: serializeTask(result.task) });
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
