import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Permission, RoleKey } from "@projecthub/shared";
import { createTaskSchema, updateTaskSchema, moveTaskSchema, createCommentSchema, taskPrioritySchema } from "@projecthub/shared";
import { toolSuccessResult, toolErrorResult, ToolFailure, type ToolCallResult } from "./mcp.protocol.js";
import { type ToolScope } from "./mcp.guard-chain.js";
import {
  serializeTaskForMcp,
  serializeProjectForMcp,
  serializeCategoryForMcp,
  serializeColumnForMcp,
} from "./mcp.serialization.js";
import { listWorkspacesForUser } from "../workspaces/workspaces.service.js";
import { listProjectsForUser } from "../projects/projects.service.js";
import { listCategoriesForUser } from "../projects/categories.service.js";
import { listColumns } from "../projects/columns.service.js";
import { listTasks, createTask, updateTask, moveTask } from "../projects/tasks.service.js";
import { listComments, createComment } from "../comments/comments.service.js";
import { emitToCategory } from "../realtime/realtime.js";

/**
 * The MCP tool registry (see the architecture handoff's Decision B table).
 * `args` is the SOLE enforcement authority for input validation — nothing
 * in `run` re-derives trust from anything not already validated by `args`
 * and authorized by the guards `mcp.routes.ts`'s dispatcher runs before
 * calling `run`. Every `run` body does nothing but: read req.ctx.* (already
 * populated by those guards), call exactly one existing service function,
 * call exactly one existing serializer, and — for the four mutating tools —
 * emit the SAME realtime event the equivalent REST route already emits. No
 * Prisma queries, no business logic, directly in this file.
 */
export interface McpTool<A> {
  name: string;
  title: string;
  description: string;
  /** JSON Schema, advertised verbatim in `tools/list` — purely descriptive; `args` (zod) is what actually enforces validation. */
  inputSchema: Record<string, unknown>;
  args: z.ZodType<A>;
  scope: (args: A) => ToolScope;
  permission?: Permission;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  run: (req: FastifyRequest, reply: FastifyReply, args: A) => Promise<ToolCallResult>;
}

/** Every AgentToken-authenticated tool call has req.ctx.agentToken set — enforced by requireAgentTokenAuth on the /api/mcp route itself. */
function actingAgent(req: FastifyRequest) {
  return { agentTokenId: req.ctx.agentToken!.id, agentLabel: req.ctx.agentToken!.label };
}

// ---------------------------------------------------------------------------
// list_workspaces — user tier, no permission
// ---------------------------------------------------------------------------

const listWorkspacesArgsSchema = z.object({}).strict();

const listWorkspacesTool: McpTool<z.infer<typeof listWorkspacesArgsSchema>> = {
  name: "list_workspaces",
  title: "List workspaces",
  description: "Lists every workspace the caller is an active member of, with their role in each.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  args: listWorkspacesArgsSchema,
  scope: () => ({ tier: "user" }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(req) {
    const workspaces = await listWorkspacesForUser(req.ctx.user!.id);
    return toolSuccessResult({ workspaces });
  },
};

// ---------------------------------------------------------------------------
// list_projects — workspace tier, no permission
// ---------------------------------------------------------------------------

const listProjectsArgsSchema = z
  .object({
    workspaceId: z.string().min(1, "workspaceId is required."),
  })
  .strict();

const listProjectsTool: McpTool<z.infer<typeof listProjectsArgsSchema>> = {
  name: "list_projects",
  title: "List projects",
  description: "Lists every project in a workspace that the caller may see.",
  inputSchema: {
    type: "object",
    properties: { workspaceId: { type: "string" } },
    required: ["workspaceId"],
    additionalProperties: false,
  },
  args: listProjectsArgsSchema,
  scope: (args) => ({ tier: "workspace", workspaceId: args.workspaceId }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(req) {
    const roleKey = req.ctx.membership!.role.key as RoleKey;
    const projects = await listProjectsForUser(req.ctx.workspace!.id, req.ctx.user!.id, roleKey, {});
    return toolSuccessResult({ projects: projects.map(serializeProjectForMcp) });
  },
};

// ---------------------------------------------------------------------------
// list_categories — project tier, no permission
// ---------------------------------------------------------------------------

const listCategoriesArgsSchema = z
  .object({
    workspaceId: z.string().min(1, "workspaceId is required."),
    projectId: z.string().min(1, "projectId is required."),
  })
  .strict();

const listCategoriesTool: McpTool<z.infer<typeof listCategoriesArgsSchema>> = {
  name: "list_categories",
  title: "List categories",
  description: "Lists every category in a project that the caller may see.",
  inputSchema: {
    type: "object",
    properties: { workspaceId: { type: "string" }, projectId: { type: "string" } },
    required: ["workspaceId", "projectId"],
    additionalProperties: false,
  },
  args: listCategoriesArgsSchema,
  scope: (args) => ({ tier: "project", workspaceId: args.workspaceId, projectId: args.projectId }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(req) {
    const roleKey = req.ctx.membership!.role.key as RoleKey;
    const categories = await listCategoriesForUser(req.ctx.project!.id, req.ctx.user!.id, roleKey);
    return toolSuccessResult({ categories: categories.map(serializeCategoryForMcp) });
  },
};

// ---------------------------------------------------------------------------
// list_columns — category tier, no permission
// ---------------------------------------------------------------------------

const categoryScopedArgsSchema = z
  .object({
    workspaceId: z.string().min(1, "workspaceId is required."),
    projectId: z.string().min(1, "projectId is required."),
    categoryId: z.string().min(1, "categoryId is required."),
  })
  .strict();

const listColumnsTool: McpTool<z.infer<typeof categoryScopedArgsSchema>> = {
  name: "list_columns",
  title: "List board columns",
  description:
    "Lists every board column (e.g. To Do / In Progress / Done) in a category. Call this before move_task to discover valid columnId values.",
  inputSchema: {
    type: "object",
    properties: { workspaceId: { type: "string" }, projectId: { type: "string" }, categoryId: { type: "string" } },
    required: ["workspaceId", "projectId", "categoryId"],
    additionalProperties: false,
  },
  args: categoryScopedArgsSchema,
  scope: (args) => ({ tier: "category", workspaceId: args.workspaceId, projectId: args.projectId, categoryId: args.categoryId }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(req) {
    const columns = await listColumns(req.ctx.category!.id);
    return toolSuccessResult({ columns: columns.map(serializeColumnForMcp) });
  },
};

// ---------------------------------------------------------------------------
// list_tasks — category tier, no permission
//
// Deliberately its OWN boolean fields for overdue/hasSubtasks, NOT a reuse
// of taskListQuerySchema's string-enum-plus-transform shape: an MCP client
// sends real JSON booleans, not the query-string "true"/"false" strings the
// REST route's querystring parser hands taskListQuerySchema.
// ---------------------------------------------------------------------------

const listTasksArgsSchema = z
  .object({
    workspaceId: z.string().min(1, "workspaceId is required."),
    projectId: z.string().min(1, "projectId is required."),
    categoryId: z.string().min(1, "categoryId is required."),
    q: z.string().trim().min(1).max(255).optional(),
    columnId: z.string().min(1).optional(),
    priority: taskPrioritySchema.optional(),
    assigneeId: z.string().min(1).optional(),
    labelId: z.string().min(1).optional(),
    parentTaskId: z.string().min(1).optional(),
    overdue: z.boolean().optional(),
    hasSubtasks: z.boolean().optional(),
  })
  .strict();

const listTasksTool: McpTool<z.infer<typeof listTasksArgsSchema>> = {
  name: "list_tasks",
  title: "List tasks",
  description: "Lists tasks in a category, with optional filters. The returned tasks include their current `version`, needed by update_task/move_task.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "string" },
      projectId: { type: "string" },
      categoryId: { type: "string" },
      q: { type: "string" },
      columnId: { type: "string" },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      assigneeId: { type: "string" },
      labelId: { type: "string" },
      parentTaskId: { type: "string" },
      overdue: { type: "boolean" },
      hasSubtasks: { type: "boolean" },
    },
    required: ["workspaceId", "projectId", "categoryId"],
    additionalProperties: false,
  },
  args: listTasksArgsSchema,
  scope: (args) => ({ tier: "category", workspaceId: args.workspaceId, projectId: args.projectId, categoryId: args.categoryId }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(req, _reply, args) {
    const tasks = await listTasks(req.ctx.category!.id, {
      ...(args.q !== undefined ? { q: args.q } : {}),
      ...(args.columnId !== undefined ? { columnId: args.columnId } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.assigneeId !== undefined ? { assigneeId: args.assigneeId } : {}),
      ...(args.labelId !== undefined ? { labelId: args.labelId } : {}),
      ...(args.parentTaskId !== undefined ? { parentTaskId: args.parentTaskId } : {}),
      ...(args.overdue !== undefined ? { overdue: args.overdue } : {}),
      ...(args.hasSubtasks !== undefined ? { hasSubtasks: args.hasSubtasks } : {}),
    });
    return toolSuccessResult({ tasks: tasks.map(serializeTaskForMcp) });
  },
};

// ---------------------------------------------------------------------------
// create_task — category tier, task.create
// ---------------------------------------------------------------------------

const createTaskArgsSchema = createTaskSchema
  .extend({
    workspaceId: z.string().min(1, "workspaceId is required."),
    projectId: z.string().min(1, "projectId is required."),
    categoryId: z.string().min(1, "categoryId is required."),
  })
  .strict();

const createTaskTool: McpTool<z.infer<typeof createTaskArgsSchema>> = {
  name: "create_task",
  title: "Create task",
  description: "Creates a new task in a category's board. Call list_columns first if you need a specific columnId.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "string" },
      projectId: { type: "string" },
      categoryId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      columnId: { type: "string" },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      parentTaskId: { type: "string" },
      milestoneId: { type: "string" },
      startDate: { type: "string", format: "date-time" },
      dueDate: { type: "string", format: "date-time" },
    },
    required: ["workspaceId", "projectId", "categoryId", "title"],
    additionalProperties: false,
  },
  args: createTaskArgsSchema,
  permission: "task.create",
  scope: (args) => ({ tier: "category", workspaceId: args.workspaceId, projectId: args.projectId, categoryId: args.categoryId }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(req, _reply, args) {
    const { workspaceId, projectId, categoryId, ...input } = args;
    const task = await createTask({
      workspaceId: req.ctx.workspace!.id,
      projectId: req.ctx.project!.id,
      categoryId: req.ctx.category!.id,
      creatorId: req.ctx.user!.id,
      creatorDisplayName: req.ctx.user!.displayName,
      input,
      via: actingAgent(req),
    });
    const serialized = serializeTaskForMcp(task);
    emitToCategory(req.ctx.category!.id, "task.created", serialized);
    return toolSuccessResult({ task: serialized });
  },
};

// ---------------------------------------------------------------------------
// update_task — category tier, task.edit
//
// Two-stage parse: the outer schema (below) is loose about everything
// EXCEPT the routing/scope fields (workspaceId/projectId/categoryId/taskId,
// required) and passes the rest through untouched; `run` then delegates the
// rest to updateTaskSchema.safeParse itself, since updateTaskSchema is a
// ZodEffects (it has a .superRefine) and therefore has no .extend().
// ---------------------------------------------------------------------------

const updateTaskOuterArgsSchema = z
  .object({
    workspaceId: z.string().min(1, "workspaceId is required."),
    projectId: z.string().min(1, "projectId is required."),
    categoryId: z.string().min(1, "categoryId is required."),
    taskId: z.string().min(1, "taskId is required."),
  })
  .passthrough();

const updateTaskTool: McpTool<z.infer<typeof updateTaskOuterArgsSchema>> = {
  name: "update_task",
  title: "Update task",
  description:
    "Updates an existing task's fields (title/description/priority/dates/completed/recurrence/etc). Requires the task's current `version` (from list_tasks) for optimistic concurrency; a stale version returns the fresh current task in an error result so you can retry.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "string" },
      projectId: { type: "string" },
      categoryId: { type: "string" },
      taskId: { type: "string" },
      version: { type: "integer" },
      title: { type: "string" },
      description: { type: "string" },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      parentTaskId: { type: "string" },
      milestoneId: { type: "string" },
      startDate: { type: "string", format: "date-time" },
      dueDate: { type: "string", format: "date-time" },
      completed: { type: "boolean" },
    },
    required: ["workspaceId", "projectId", "categoryId", "taskId", "version"],
    additionalProperties: true,
  },
  args: updateTaskOuterArgsSchema,
  permission: "task.edit",
  scope: (args) => ({ tier: "category", workspaceId: args.workspaceId, projectId: args.projectId, categoryId: args.categoryId }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(req, _reply, args) {
    const { workspaceId, projectId, categoryId, taskId, ...rest } = args;
    const parsed = updateTaskSchema.safeParse(rest);
    if (!parsed.success) {
      return toolErrorResult(parsed.error.issues[0]?.message ?? "Invalid input.");
    }

    const result = await updateTask(
      req.ctx.workspace!.id,
      req.ctx.project!.id,
      req.ctx.category!.id,
      taskId,
      parsed.data,
      { id: req.ctx.user!.id, displayName: req.ctx.user!.displayName, via: actingAgent(req) },
    );

    if (result.conflict) {
      throw new ToolFailure(
        "This task was changed by someone else. Refresh to see the latest version and try again.",
        { currentTask: serializeTaskForMcp(result.currentTask) },
      );
    }

    const serialized = serializeTaskForMcp(result.task);
    emitToCategory(req.ctx.category!.id, "task.updated", serialized);
    return toolSuccessResult({ task: serialized });
  },
};

// ---------------------------------------------------------------------------
// move_task — category tier, task.edit
// ---------------------------------------------------------------------------

const moveTaskArgsSchema = moveTaskSchema
  .extend({
    workspaceId: z.string().min(1, "workspaceId is required."),
    projectId: z.string().min(1, "projectId is required."),
    categoryId: z.string().min(1, "categoryId is required."),
    taskId: z.string().min(1, "taskId is required."),
  })
  .strict();

const moveTaskTool: McpTool<z.infer<typeof moveTaskArgsSchema>> = {
  name: "move_task",
  title: "Move task",
  description:
    "Moves a task to a different board column and/or position within it. Requires the task's current `version` (from list_tasks). Call list_columns first to discover valid columnId values.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "string" },
      projectId: { type: "string" },
      categoryId: { type: "string" },
      taskId: { type: "string" },
      version: { type: "integer" },
      columnId: { type: "string" },
      beforeTaskId: { type: "string" },
      afterTaskId: { type: "string" },
    },
    required: ["workspaceId", "projectId", "categoryId", "taskId", "version", "columnId"],
    additionalProperties: false,
  },
  args: moveTaskArgsSchema,
  permission: "task.edit",
  scope: (args) => ({ tier: "category", workspaceId: args.workspaceId, projectId: args.projectId, categoryId: args.categoryId }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(req, _reply, args) {
    const { workspaceId, projectId, categoryId, taskId, ...moveInput } = args;
    const result = await moveTask(
      req.ctx.workspace!.id,
      req.ctx.project!.id,
      req.ctx.category!.id,
      taskId,
      moveInput,
      { id: req.ctx.user!.id, displayName: req.ctx.user!.displayName, via: actingAgent(req) },
    );

    if (result.conflict) {
      throw new ToolFailure(
        "This task was changed by someone else. Refresh to see the latest version and try again.",
        { currentTask: serializeTaskForMcp(result.currentTask) },
      );
    }

    const serialized = serializeTaskForMcp(result.task);
    emitToCategory(req.ctx.category!.id, "task.moved", serialized);
    return toolSuccessResult({ task: serialized });
  },
};

// ---------------------------------------------------------------------------
// list_comments — category tier, no permission
// ---------------------------------------------------------------------------

const taskScopedArgsSchema = z
  .object({
    workspaceId: z.string().min(1, "workspaceId is required."),
    projectId: z.string().min(1, "projectId is required."),
    categoryId: z.string().min(1, "categoryId is required."),
    taskId: z.string().min(1, "taskId is required."),
  })
  .strict();

const listCommentsTool: McpTool<z.infer<typeof taskScopedArgsSchema>> = {
  name: "list_comments",
  title: "List comments",
  description: "Lists every comment on a task, oldest first.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "string" },
      projectId: { type: "string" },
      categoryId: { type: "string" },
      taskId: { type: "string" },
    },
    required: ["workspaceId", "projectId", "categoryId", "taskId"],
    additionalProperties: false,
  },
  args: taskScopedArgsSchema,
  scope: (args) => ({ tier: "category", workspaceId: args.workspaceId, projectId: args.projectId, categoryId: args.categoryId }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(req, _reply, args) {
    const comments = await listComments(req.ctx.workspace!.id, req.ctx.category!.id, args.taskId);
    return toolSuccessResult({ comments });
  },
};

// ---------------------------------------------------------------------------
// add_comment — category tier, task.edit
// ---------------------------------------------------------------------------

const addCommentArgsSchema = createCommentSchema
  .extend({
    workspaceId: z.string().min(1, "workspaceId is required."),
    projectId: z.string().min(1, "projectId is required."),
    categoryId: z.string().min(1, "categoryId is required."),
    taskId: z.string().min(1, "taskId is required."),
  })
  .strict();

const addCommentTool: McpTool<z.infer<typeof addCommentArgsSchema>> = {
  name: "add_comment",
  title: "Add comment",
  description: "Adds a comment to a task. Requires the same task.edit permission as editing the task itself.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "string" },
      projectId: { type: "string" },
      categoryId: { type: "string" },
      taskId: { type: "string" },
      body: { type: "string" },
    },
    required: ["workspaceId", "projectId", "categoryId", "taskId", "body"],
    additionalProperties: false,
  },
  args: addCommentArgsSchema,
  permission: "task.edit",
  scope: (args) => ({ tier: "category", workspaceId: args.workspaceId, projectId: args.projectId, categoryId: args.categoryId }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(req, _reply, args) {
    // createComment already emits both the "comment.created" realtime event
    // and the activity-feed broadcast internally (see comments.service.ts)
    // — unlike create_task/update_task/move_task, there is nothing left for
    // this tool to emit itself.
    const comment = await createComment({
      workspaceId: req.ctx.workspace!.id,
      projectId: req.ctx.project!.id,
      categoryId: req.ctx.category!.id,
      taskId: args.taskId,
      authorId: req.ctx.user!.id,
      authorDisplayName: req.ctx.user!.displayName,
      input: { body: args.body },
      via: actingAgent(req),
    });
    return toolSuccessResult({ comment });
  },
};

/** Every McpTool, in table order — the complete v1 tool surface, exactly 10. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MCP_TOOLS: McpTool<any>[] = [
  listWorkspacesTool,
  listProjectsTool,
  listCategoriesTool,
  listColumnsTool,
  listTasksTool,
  createTaskTool,
  updateTaskTool,
  moveTaskTool,
  listCommentsTool,
  addCommentTool,
];

export function findMcpTool(name: string): McpTool<unknown> | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}
