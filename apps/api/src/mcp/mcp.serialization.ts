/**
 * Model-facing serializer functions for the MCP tools (mcp.tools.ts).
 * Deliberately thin: every shape here either reuses an existing serializer
 * (serializeTask) or trims a raw Prisma row down to the same handful of
 * fields the REST routes already expose, rather than reimplementing any
 * shaping logic. Comments need no serializer at all here — comments.service
 * .ts's listComments/createComment already return their fully-serialized
 * wire shape directly.
 */
import type { BoardColumn, TaskCategory } from "@prisma/client";
import { serializeTask, type TaskWithRelations } from "../projects/task-serialization.js";

export { serializeTask as serializeTaskForMcp };

export interface ProjectForMcp {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  startDate: Date | null;
  targetDate: Date | null;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function serializeProjectForMcp(project: ProjectForMcp) {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    description: project.description,
    status: project.status,
    visibility: project.visibility,
    startDate: project.startDate,
    targetDate: project.targetDate,
    archived: project.archived,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function serializeCategoryForMcp(category: TaskCategory) {
  return {
    id: category.id,
    projectId: category.projectId,
    name: category.name,
    visibility: category.visibility,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}

export function serializeColumnForMcp(column: BoardColumn) {
  return {
    id: column.id,
    categoryId: column.categoryId,
    name: column.name,
    category: column.category,
    color: column.color,
    position: column.position,
  };
}

export type { TaskWithRelations };
