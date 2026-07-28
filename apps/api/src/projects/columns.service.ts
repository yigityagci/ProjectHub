import type { CreateColumnInput, UpdateColumnInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { ConflictError, NotFoundError } from "../core/errors.js";
import { computeAppendPosition } from "./position.js";

const COLUMN_NOT_FOUND_MESSAGE = "This column doesn't exist in this project.";

export async function listColumns(projectId: string) {
  return prisma.boardColumn.findMany({
    where: { projectId },
    orderBy: { position: "asc" },
  });
}

export async function getColumnOrThrow(workspaceId: string, projectId: string, columnId: string) {
  const column = await prisma.boardColumn.findFirst({
    where: { id: columnId, projectId, workspaceId },
  });
  if (!column) {
    throw new NotFoundError(COLUMN_NOT_FOUND_MESSAGE);
  }
  return column;
}

export async function createColumn(workspaceId: string, projectId: string, input: CreateColumnInput) {
  const maxPositionColumn = await prisma.boardColumn.findFirst({
    where: { projectId },
    orderBy: { position: "desc" },
  });

  return prisma.boardColumn.create({
    data: {
      workspaceId,
      projectId,
      name: input.name,
      category: input.category,
      position: computeAppendPosition(maxPositionColumn?.position ?? null),
    },
  });
}

export async function updateColumn(
  workspaceId: string,
  projectId: string,
  columnId: string,
  input: UpdateColumnInput,
) {
  await getColumnOrThrow(workspaceId, projectId, columnId);
  return prisma.boardColumn.update({
    where: { id: columnId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
    },
  });
}

export async function reorderColumns(workspaceId: string, projectId: string, columnIds: string[]) {
  const columns = await prisma.boardColumn.findMany({ where: { projectId, workspaceId } });
  const columnIdSet = new Set(columns.map((c) => c.id));

  if (columnIds.length !== columns.length || !columnIds.every((id) => columnIdSet.has(id))) {
    throw new NotFoundError(
      "The column list must include every column of this project exactly once.",
    );
  }

  await prisma.$transaction(
    columnIds.map((id, index) =>
      prisma.boardColumn.update({ where: { id }, data: { position: index + 1 } }),
    ),
  );

  return listColumns(projectId);
}

export async function deleteColumn(workspaceId: string, projectId: string, columnId: string) {
  await getColumnOrThrow(workspaceId, projectId, columnId);

  const taskCount = await prisma.task.count({ where: { columnId } });
  if (taskCount > 0) {
    throw new ConflictError(
      "This column still has tasks in it. Move or delete its tasks before deleting the column.",
    );
  }

  try {
    await prisma.boardColumn.delete({ where: { id: columnId } });
  } catch (_err) {
    // Defense in depth against a race where a task was inserted into this
    // column between the count check above and the delete (the FK is
    // onDelete: Restrict), surfaced as a clean 409 instead of a raw DB error.
    throw new ConflictError(
      "This column still has tasks in it. Move or delete its tasks before deleting the column.",
    );
  }
}
